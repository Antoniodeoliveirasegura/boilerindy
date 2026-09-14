// Bucket key for POST /api/auth/supabase-sync (issue #217).
//
// Every app launch and every hourly Supabase token refresh hits that route,
// and it used to be limited per IP: a lecture hall behind one campus NAT
// shared a single 120-per-15-minute budget and locked each other out. The
// request carries a Supabase access token (a JWT) whose `sub` is the user id,
// so the bucket can be the user instead. The token is not verified here (the
// route does that with GoTrue afterwards); a forged `sub` only buys the
// forger a separate bucket, and the route still sits behind a wider per-IP
// cap so one address cannot mint unlimited buckets.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function decodeSegment(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return Buffer.from(padded, 'base64').toString('utf8')
}

/** The `sub` claim of a JWT-shaped token, without verifying it; null otherwise. */
export function jwtSubject(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(decodeSegment(parts[1]))
    const sub = payload?.sub
    return typeof sub === 'string' && sub.length > 0 && sub.length <= 200 ? sub : null
  } catch {
    return null
  }
}

/**
 * The user this sync request is about: the bearer (or body) token's `sub`,
 * else the body's supabaseUserId when it is a UUID, else null so the limiter
 * falls back to the client IP.
 */
export function sessionSyncBucketKey(req) {
  const header = String(req?.headers?.authorization || '')
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const token = bearer || (typeof req?.body?.accessToken === 'string' ? req.body.accessToken : '')
  const sub = jwtSubject(token)
  if (sub) return `sub:${sub}`
  const bodyId = req?.body?.supabaseUserId
  if (typeof bodyId === 'string' && UUID_RE.test(bodyId)) return `uid:${bodyId.toLowerCase()}`
  return null
}
