import { createHash } from 'node:crypto'

// The cookie express-session sets in server.mjs. Exported so the session
// config, the sign-out routes and this parser cannot disagree on the name.
export const SESSION_COOKIE_NAME = 'pih.sid'

/**
 * The value of one cookie from a Cookie header, or null. The name must match
 * exactly; the value comes back as sent (still URL-encoded).
 */
export function readCookie(header, name) {
  if (typeof header !== 'string' || !header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    return value || null
  }
  return null
}

/**
 * Bucket key for the session-free public reads (issue #250). Those routes are
 * registered before the session middleware, so req.session is never set on
 * them; keying on a hash prefix of the session cookie keeps #215's fairness
 * (app users behind one campus NAT get separate budgets) without running the
 * session. Null when the request carries no cookie, which createRateLimiter
 * turns into the client IP. The raw cookie value never appears in the key.
 * Anyone can mint fresh cookie values, so an outer per-IP limiter caps what
 * one address can spend across all of them.
 */
export function publicReadBucketKey(req) {
  const value = readCookie(req?.headers?.cookie, SESSION_COOKIE_NAME)
  if (!value) return null
  return 'sid:' + createHash('sha256').update(value).digest('hex').slice(0, 16)
}
