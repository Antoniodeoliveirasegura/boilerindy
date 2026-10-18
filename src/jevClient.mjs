// TypeSafe's Jev (issue #30): a decision model that reads a `state` and
// answers typed questions with calibrated probabilities instead of text. A
// noul answers how likely a statement is true; a choice picks one option and
// gives every option a probability (https://docs.typesafe.ai/api). Plain fetch
// against POST /v1/systemone, no SDK, like src/groqClient.mjs, so the backend
// keeps its zero-dependency footprint and the wire format is tested with an
// injected fetch and no key.
//
// TypeSafe asks clients to retry 429 (rate limited) and 529 (overloaded) with
// exponential backoff; a 5xx, a timeout or a network error gets the same here.
// Anything else (401 a bad key, 422 a malformed question, 400 a request over
// the context length) is our request, and fails at once marked `fatal`, so a
// batch stops instead of repeating it for every row.

export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_TIMEOUT_MS = 20_000
export const JEV_MAX_RETRIES = 3
const RETRY_BASE_MS = 500
const RETRY_AFTER_MAX_MS = 10_000
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])

/** A call that failed. `status` is Jev's HTTP status (null when none came back); `fatal` means retrying cannot help. */
export class JevError extends Error {
  constructor(message, { status = null, body = '', fatal = false, cause } = {}) {
    super(body ? `${message}: ${body}` : message)
    this.name = 'JevError'
    this.status = status
    this.body = body
    this.fatal = fatal
    if (cause) this.cause = cause
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How long to wait before retry `attempt` (from 0): the `retry-after` header
 * in seconds when Jev sent one (at most 10 s), else 0.5 s doubling, with
 * jitter so parallel workers do not retry in step.
 */
export function retryDelayMs(attempt, retryAfter = null, random = Math.random) {
  if (retryAfter != null && String(retryAfter).trim() !== '') {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS)
  }
  return Math.round(RETRY_BASE_MS * 2 ** attempt * (0.5 + random() / 2))
}

/**
 * A client bound to one key and one model id. `evaluate(state, questions)`
 * resolves with `{ model, answers, usage }`: the versioned id that answered,
 * one answer per question key as Jev sent it, and the token count. It throws
 * JevError once the retries are spent or at once for a fatal status. The key
 * goes in the Authorization header only, never into an error or a log line.
 */
export function createJevClient({
  apiKey,
  model,
  url = JEV_API_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = JEV_TIMEOUT_MS,
  maxRetries = JEV_MAX_RETRIES,
  sleep = wait,
  random = Math.random,
} = {}) {
  if (!apiKey) throw new Error('createJevClient needs an API key')
  if (!model) throw new Error('createJevClient needs a model id')

  async function evaluate(state, questions) {
    const body = JSON.stringify({ state, model, questions })
    for (let attempt = 0; ; attempt += 1) {
      let response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (attempt < maxRetries) {
          await sleep(retryDelayMs(attempt, null, random))
          continue
        }
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        throw new JevError(timedOut ? 'Jev timed out' : 'Jev is unreachable', { cause: error })
      }
      if (response.ok) {
        let data
        try {
          data = await response.json()
        } catch (error) {
          throw new JevError('Jev answered something other than JSON', { status: response.status, cause: error })
        }
        if (!data || typeof data.answers !== 'object' || data.answers === null) {
          throw new JevError('Jev answered without answers', { status: response.status })
        }
        return { model: String(data.model || model), answers: data.answers, usage: data.usage ?? null }
      }
      const text = String(await response.text().catch(() => '')).slice(0, 300)
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        await sleep(retryDelayMs(attempt, response.headers?.get?.('retry-after'), random))
        continue
      }
      throw new JevError(`Jev responded ${response.status}`, {
        status: response.status,
        body: text,
        fatal: !RETRYABLE_STATUS.has(response.status),
      })
    }
  }

  return { model, evaluate }
}
