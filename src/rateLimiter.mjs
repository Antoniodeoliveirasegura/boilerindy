/**
 * Configurable in-memory rate limiting for API endpoints (issue #22).
 *
 * Fixed-window counters keyed by the signed-in user id, or the client IP
 * for anonymous requests. Every limiter can be tuned without code changes:
 *
 *   RATE_LIMIT_ENABLED=false             disables all limiters (load tests)
 *   RATE_LIMIT_<NAME>_MAX=<n>            overrides a limiter's request budget
 *   RATE_LIMIT_<NAME>_WINDOW_MS=<ms>     overrides a limiter's window length
 *
 * <NAME> is the limiter name upper-cased with non-alphanumerics as "_"
 * (e.g. name "board-write" -> RATE_LIMIT_BOARD_WRITE_MAX).
 *
 * Endpoint coverage is documented in docs/RATE_LIMITS.md.
 */

const globalEnabled = String(process.env.RATE_LIMIT_ENABLED ?? 'true').toLowerCase() !== 'false'

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

const allWindowStores = []
const cleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const store of allWindowStores) {
    for (const [key, win] of store) {
      if (now >= win.resetAt) store.delete(key)
    }
  }
}, CLEANUP_INTERVAL_MS)
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref()

function envNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** The bucket a request lands in for a given keyBy strategy. */
export function bucketKey(req, keyBy = 'userOrIp') {
  if (typeof keyBy === 'function') {
    let custom = null
    try {
      custom = keyBy(req)
    } catch {
      custom = null
    }
    if (typeof custom === 'string' && custom) return `k:${custom}`
    return `ip:${req.ip}`
  }
  if (keyBy !== 'ip' && req.session?.userId) return `u:${req.session.userId}`
  return `ip:${req.ip}`
}

function formatRetry(seconds) {
  if (seconds < 90) return `${seconds} seconds`
  return `about ${Math.ceil(seconds / 60)} minutes`
}

/**
 * Build an Express middleware enforcing `max` requests per `windowMs`.
 *
 * @param {object} options
 * @param {string} options.name      Limiter name (used for env overrides + logs)
 * @param {number} options.windowMs  Window length in milliseconds
 * @param {number} options.max       Allowed requests per window
 * @param {'userOrIp'|'ip'|((req: object) => string|null)} [options.keyBy='userOrIp']
 *   Bucket key strategy. A function returns its own key (prefixed `k:`) or
 *   null to fall back to the client IP; used where the caller is identified
 *   by something other than the cookie session (issue #217).
 * @param {string} [options.message] User-facing message on 429
 * @param {(req: object, res: object, info: { retryAfterSeconds: number }) => void} [options.onLimit]
 *   Answers a blocked request instead of the JSON 429, for routes whose caller
 *   is a browser redirect rather than a fetch (issue #293). The RateLimit
 *   headers, Retry-After and the log line are the same either way.
 */
export function createRateLimiter({ name, windowMs, max, keyBy = 'userOrIp', message, onLimit }) {
  const envKey = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const limit = envNumber(`RATE_LIMIT_${envKey}_MAX`, max)
  const window = envNumber(`RATE_LIMIT_${envKey}_WINDOW_MS`, windowMs)
  const windows = new Map()
  allWindowStores.push(windows)

  return function rateLimit(req, res, next) {
    if (!globalEnabled) return next()

    const key = bucketKey(req, keyBy)
    const now = Date.now()

    let win = windows.get(key)
    if (!win || now >= win.resetAt) {
      win = { count: 0, resetAt: now + window, logged: false }
      windows.set(key, win)
    }
    win.count += 1

    res.setHeader('RateLimit-Limit', String(limit))
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - win.count)))
    res.setHeader('RateLimit-Reset', String(Math.ceil((win.resetAt - now) / 1000)))

    if (win.count <= limit) return next()

    const retryAfterSeconds = Math.max(1, Math.ceil((win.resetAt - now) / 1000))
    if (!win.logged) {
      win.logged = true
      console.warn(
        `[rate-limit] ${name}: blocked ${key} on ${req.method} ${req.path} ` +
          `(${win.count} requests, limit ${limit}/${Math.round(window / 1000)}s)`,
      )
    }
    res.setHeader('Retry-After', String(retryAfterSeconds))
    if (typeof onLimit === 'function') return onLimit(req, res, { retryAfterSeconds })
    return res.status(429).json({
      error: {
        message: message || `Too many requests. Please try again in ${formatRetry(retryAfterSeconds)}.`,
        status: 429,
        retryAfterSeconds,
      },
    })
  }
}
