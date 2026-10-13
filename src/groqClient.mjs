// Groq client for the campus assistant and the board AI features. Plain fetch
// against Groq's OpenAI-compatible chat completions endpoint
// (https://console.groq.com/docs/api-reference), no SDK, so the backend keeps
// its zero-dependency footprint. Lives outside server.mjs so the wire format
// can be unit-tested with an injected fetch and no real key.
//
// History: Gemini -> xAI Grok (#182) -> Groq (2026-09-14). Groq (groq.com) and
// xAI's Grok are different companies; a key from one is rejected by the other.
// Groq keys start with "gsk_".

export const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'

// openai/gpt-oss-120b is a reasoning model; with reasoning_effort "low" it
// answers quickly enough for the chat widget and the fire-and-forget tagger.
// Override with GROQ_MODEL; ids and prices: https://console.groq.com/docs/models
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b'
export const DEFAULT_REASONING_EFFORT = 'low'

// Groq rate limits are per organisation and per model (issue #253), so when the
// primary model answers 429 one retry on a smaller model often still gets
// through. Groq also serves each model separately, so the same retry covers a
// 5xx from the primary (issue #447). Override with GROQ_FALLBACK_MODEL; an
// empty string turns it off.
export const DEFAULT_GROQ_FALLBACK_MODEL = 'openai/gpt-oss-20b'

/**
 * A non-2xx reply from Groq. `body` is the raw upstream text for the server log.
 * `retryAfter` (seconds) and `remainingTokens` come from the `retry-after` and
 * `x-ratelimit-remaining-tokens` headers, null when Groq did not send them.
 */
export class GroqUpstreamError extends Error {
  constructor(status, body, { retryAfter = null, remainingTokens = null } = {}) {
    super(`Groq responded ${status}`)
    this.name = 'GroqUpstreamError'
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
    this.remainingTokens = remainingTokens
  }
}

/** A numeric response header as a number, or null when it is absent or not a number. */
function numericHeader(headers, name) {
  const raw = headers?.get?.(name)
  if (raw == null || String(raw).trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Which reasoning_effort to send. Only the gpt-oss family accepts low | medium
 * | high; other models reject the field or expect a different vocabulary, so
 * they get nothing unless the caller set one explicitly.
 */
export function resolveReasoningEffort(model, configured) {
  if (configured) return configured
  return /^openai\/gpt-oss/.test(model || '') ? DEFAULT_REASONING_EFFORT : undefined
}

/**
 * Build a chat-completions body. `messages` are { role, content } turns in
 * conversation order; anything but user/assistant is dropped and content is
 * coerced to a string. `system` becomes the leading system message.
 */
export function buildGroqRequest({
  model = DEFAULT_GROQ_MODEL,
  system,
  messages = [],
  maxOutputTokens,
  temperature,
  reasoningEffort,
} = {}) {
  const chat = []
  if (system) chat.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue
    chat.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
    })
  }
  const body = { model, messages: chat }
  // max_tokens is deprecated on this endpoint; max_completion_tokens is the current name.
  if (Number.isFinite(maxOutputTokens)) body.max_completion_tokens = maxOutputTokens
  if (Number.isFinite(temperature)) body.temperature = temperature
  const effort = resolveReasoningEffort(model, reasoningEffort)
  if (effort) body.reasoning_effort = effort
  return body
}

/**
 * The reply text from a chat-completions payload, or null when there is none
 * (no choices, a refusal, an unexpected shape). Reasoning models return their
 * thinking in `message.reasoning`, which is ignored; only `content` counts.
 * `content` is a string on Groq, but an array of text parts is accepted too.
 */
export function extractGroqText(data) {
  const message = data?.choices?.[0]?.message
  if (!message) return null
  const content = message.content
  if (typeof content === 'string') return content.length ? content : null
  if (Array.isArray(content)) {
    const parts = content.filter((p) => typeof p?.text === 'string').map((p) => p.text)
    return parts.length ? parts.join('') : null
  }
  return null
}

/**
 * Why a failed call on the primary model earns one retry on the fallback, or
 * null when it does not: a 429 is that model's own rate limit (issue #253) and
 * a 5xx is Groq failing to serve it (issue #447). Any other status is our
 * request or our key, and a network error never reached Groq; a second model
 * would fail the same way.
 */
function fallbackReason(err) {
  if (!(err instanceof GroqUpstreamError)) return null
  if (err.status === 429) return 'rate_limited'
  if (err.status >= 500 && err.status <= 599) return 'upstream_error'
  return null
}

/**
 * A client bound to one API key. `reply()` resolves to the reply text (null when
 * the model returned nothing) and throws GroqUpstreamError on a non-2xx status
 * so each route keeps its own error policy. A 429 or a 5xx from the primary
 * model is retried exactly once on `fallbackModel` (default
 * DEFAULT_GROQ_FALLBACK_MODEL, empty string disables), after
 * `onFallback(err, { model, fallbackModel, reason })` hears about the primary's
 * failure, `reason` being 'rate_limited' or 'upstream_error'. A 429 from both
 * rethrows the fallback's error; any other fallback failure rethrows the
 * primary's error with the failure on `err.fallbackError`, so the caller still
 * sees what the primary said ("rate limited" stays rate limited, a 5xx stays a
 * 5xx). `fetchImpl` is for tests.
 */
export function createGroqClient({
  apiKey,
  model,
  fallbackModel,
  reasoningEffort,
  onFallback,
  url = GROQ_CHAT_URL,
  fetchImpl,
} = {}) {
  const resolvedModel = model || DEFAULT_GROQ_MODEL
  const resolvedFallback = fallbackModel ?? DEFAULT_GROQ_FALLBACK_MODEL
  // A fallback equal to the primary would only hit the same exhausted bucket.
  const retryModel = resolvedFallback && resolvedFallback !== resolvedModel ? resolvedFallback : null

  async function send(modelId, { system, messages, maxOutputTokens, temperature }) {
    const doFetch = fetchImpl || globalThis.fetch
    const body = buildGroqRequest({
      model: modelId,
      system,
      messages,
      maxOutputTokens,
      temperature,
      reasoningEffort,
    })
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GroqUpstreamError(response.status, text, {
        retryAfter: numericHeader(response.headers, 'retry-after'),
        remainingTokens: numericHeader(response.headers, 'x-ratelimit-remaining-tokens'),
      })
    }
    return extractGroqText(await response.json())
  }

  return {
    enabled: Boolean(apiKey),
    model: resolvedModel,
    fallbackModel: retryModel,
    async reply(options = {}) {
      try {
        return await send(resolvedModel, options)
      } catch (err) {
        const reason = fallbackReason(err)
        if (!retryModel || !reason) throw err
        onFallback?.(err, { model: resolvedModel, fallbackModel: retryModel, reason })
        try {
          return await send(retryModel, options)
        } catch (fallbackErr) {
          const fallbackLimited = fallbackErr instanceof GroqUpstreamError && fallbackErr.status === 429
          if (reason === 'rate_limited' && fallbackLimited) throw fallbackErr
          // A retired fallback id (404), a 503 or a network error must not hide
          // the primary's 429, or the route answers an error instead of the
          // busy reply. After a primary 5xx the 5xx stands even when the
          // fallback is rate limited: Groq is failing, the student is not
          // asking too much.
          err.fallbackError = fallbackErr
          throw err
        }
      }
    },
  }
}
