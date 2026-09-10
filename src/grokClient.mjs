// xAI Grok client for the campus assistant and the board AI features. Plain
// fetch against the Responses API (https://docs.x.ai), no SDK, so the backend
// keeps its zero-dependency footprint. Lives outside server.mjs so the wire
// format can be unit-tested with an injected fetch and no real key.

export const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses'

// grok-4.3 is a non-reasoning model: it answers in one pass, so the chat widget
// and the fire-and-forget post tagger are not waiting on a thinking phase.
// Override with XAI_MODEL; ids and prices: https://docs.x.ai/developers/models
export const DEFAULT_XAI_MODEL = 'grok-4.3'

/** A non-2xx reply from xAI. `body` is the raw upstream text for the server log. */
export class GrokUpstreamError extends Error {
  constructor(status, body) {
    super(`xAI responded ${status}`)
    this.name = 'GrokUpstreamError'
    this.status = status
    this.body = body
  }
}

/**
 * Build a Responses API body. `messages` are { role, content } turns in
 * conversation order; anything but user/assistant is dropped and content is
 * coerced to a string. `system` becomes the leading system message.
 * `store: false` asks xAI not to keep the exchange for later retrieval.
 */
export function buildGrokRequest({
  model = DEFAULT_XAI_MODEL,
  system,
  messages = [],
  maxOutputTokens,
  temperature,
  reasoningEffort,
} = {}) {
  const input = []
  if (system) input.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue
    input.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
    })
  }
  const body = { model, input, store: false }
  // /v1/responses rejects the chat-completions name max_tokens; this is the right one.
  if (Number.isFinite(maxOutputTokens)) body.max_output_tokens = maxOutputTokens
  if (Number.isFinite(temperature)) body.temperature = temperature
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort }
  return body
}

/**
 * The reply text from a Responses API payload, or null when there is none
 * (empty output, a refusal block, an unexpected shape). Reasoning items carry
 * no `content`, so only message items contribute.
 */
export function extractGrokText(data) {
  if (typeof data?.output_text === 'string') return data.output_text
  const items = Array.isArray(data?.output) ? data.output : []
  const parts = []
  for (const item of items) {
    if (item?.type && item.type !== 'message') continue
    if (!Array.isArray(item?.content)) continue
    for (const block of item.content) {
      if (typeof block?.text === 'string') parts.push(block.text)
    }
  }
  return parts.length ? parts.join('') : null
}

/**
 * A client bound to one API key. `reply()` resolves to the reply text (null when
 * the model returned nothing) and throws GrokUpstreamError on a non-2xx status
 * so each route keeps its own error policy. `fetchImpl` is for tests.
 */
export function createGrokClient({
  apiKey,
  model,
  reasoningEffort,
  url = XAI_RESPONSES_URL,
  fetchImpl,
} = {}) {
  const resolvedModel = model || DEFAULT_XAI_MODEL
  return {
    enabled: Boolean(apiKey),
    model: resolvedModel,
    async reply({ system, messages, maxOutputTokens, temperature } = {}) {
      const doFetch = fetchImpl || globalThis.fetch
      const body = buildGrokRequest({
        model: resolvedModel,
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
        throw new GrokUpstreamError(response.status, text)
      }
      return extractGrokText(await response.json())
    },
  }
}
