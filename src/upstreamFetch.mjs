// Outbound fetch hygiene (issue #205): a deadline on every upstream call, an
// ok-check so an HTML error page never becomes a JSON parse exception, and a
// small cache that shares one in-flight fill per key and serves the last good
// value while an upstream is down. The src/ integrations (Nutrislice,
// parking, clubs, Web Push) already did this each in their own way; this is
// the shared version for the calls that still lived in server.mjs and
// src/email.mjs (TransLoc, GoTrue, Resend).

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 8000
// After a refresh fails while a last good value exists, wait this long before
// the next request tries the upstream again, so a down provider is not hit by
// every poll.
export const STALE_RETRY_MS = 5000

/**
 * One failed upstream call. `kind` is 'timeout' (deadline hit), 'network'
 * (DNS, TLS, connection reset, "fetch failed"), 'status' (non-2xx or an
 * unparseable body; `status` and a trimmed `body` are set) or 'config'
 * (the integration is not configured at all).
 */
export class UpstreamError extends Error {
  constructor(upstream, kind, { status = null, body = '', cause } = {}) {
    const what =
      kind === 'status'
        ? `${upstream} responded ${status}`
        : kind === 'timeout'
          ? `${upstream} timed out`
          : kind === 'config'
            ? `${upstream} is not configured`
            : `${upstream} is unreachable`
    super(body ? `${what}: ${body}` : what)
    this.name = 'UpstreamError'
    this.upstream = upstream
    this.kind = kind
    this.status = status
    this.body = body
    if (cause) this.cause = cause
  }
}

export function isAbortLike(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError'
}

/**
 * fetch with a deadline and an ok-check. Resolves with the Response (already
 * known to be 2xx, or a status `acceptStatus` allowed through); throws
 * UpstreamError otherwise. `init.signal` wins over `timeoutMs` when provided.
 */
export async function fetchUpstream(
  upstream,
  url,
  { init = {}, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, fetchImpl = globalThis.fetch, acceptStatus } = {},
) {
  let response
  try {
    response = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new UpstreamError(upstream, isAbortLike(err) ? 'timeout' : 'network', { cause: err })
  }
  if (!response.ok && !(typeof acceptStatus === 'function' && acceptStatus(response.status))) {
    const body = await response.text().catch(() => '')
    throw new UpstreamError(upstream, 'status', { status: response.status, body: String(body).slice(0, 300) })
  }
  return response
}

/** fetchUpstream plus a JSON parse that reports a bad body as a status failure. */
export async function fetchUpstreamJson(upstream, url, options) {
  const response = await fetchUpstream(upstream, url, options)
  try {
    return await response.json()
  } catch (err) {
    throw new UpstreamError(upstream, 'status', { status: response.status, body: 'invalid JSON body', cause: err })
  }
}

/**
 * TTL cache for quasi-static upstream reads. Within the TTL a hit returns
 * instantly; on a miss the first caller runs `producer` and every concurrent
 * caller awaits that same promise, so a burst never repeats the upstream call.
 * When a refresh fails and a previous value exists, that value is served and
 * the next attempt waits STALE_RETRY_MS; with no previous value the error
 * propagates and the next caller retries. Failures are never cached.
 */
export function createStaleCache({ now = () => Date.now(), log = console } = {}) {
  const entries = new Map() // key -> { value, has, expiresAt, pending }

  async function get(key, ttlMs, producer) {
    const t = now()
    let entry = entries.get(key)
    if (entry?.has && t < entry.expiresAt) return entry.value
    if (entry?.pending) return entry.pending
    if (!entry) {
      entry = { value: undefined, has: false, expiresAt: 0, pending: null }
      entries.set(key, entry)
    }
    entry.pending = (async () => {
      try {
        const value = await producer()
        entry.value = value
        entry.has = true
        entry.expiresAt = now() + ttlMs
        return value
      } catch (err) {
        if (entry.has) {
          log.warn(`[cache] ${key}: refresh failed (${err?.message || err}); serving the last good value`)
          entry.expiresAt = now() + Math.min(ttlMs, STALE_RETRY_MS)
          return entry.value
        }
        throw err
      } finally {
        entry.pending = null
      }
    })()
    return entry.pending
  }

  return {
    get,
    /** The cached value for a key without touching the upstream (undefined when none). */
    peek: (key) => (entries.get(key)?.has ? entries.get(key).value : undefined),
    clear: () => entries.clear(),
  }
}
