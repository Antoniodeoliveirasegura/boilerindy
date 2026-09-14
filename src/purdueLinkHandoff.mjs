import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/**
 * Purdue link handoff for native clients (issue #214).
 *
 * The website links a Purdue identity by sending the browser to
 * /auth/purdue/connect with the session cookie already set. A native app
 * cannot do that: the system browser it opens for CAS has its own cookie jar.
 * So the app first calls POST /api/purdue/link-token with its session, gets a
 * short-lived signed token bound to the student, opens
 * /auth/purdue/connect?t=<token> in an auth session, and the callback
 * finishes on <scheme>://purdue-linked?status=ok|error.
 *
 * Tokens are HMAC-signed with SESSION_SECRET under a distinct domain string,
 * expire after ttlMs (10 minutes), and are single use. Consumed token ids are
 * kept in memory per process, so after a restart a token could be replayed
 * inside its remaining window; the CAS ticket it carries is single use on the
 * Purdue side regardless, and the window is short.
 */

export const DEFAULT_SCHEME = 'boilerindyapp'
export const RETURN_HOST = 'purdue-linked'
export const DEFAULT_TTL_MS = 10 * 60 * 1000
const MAX_TOKEN_LENGTH = 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
// RFC 3986 scheme: letter then letters, digits, +, . or -. Bounded so a bad env
// value cannot become an open redirect target.
const SCHEME = /^[a-z][a-z0-9+.-]{1,63}$/

export class HandoffError extends Error {
  constructor(message, status = 400, reason = 'invalid') {
    super(message)
    this.status = status
    this.reason = reason
  }
}

const invalid = () => new HandoffError('This link is not valid. Start again from the app.', 400, 'invalid')

export function normalizeScheme(value) {
  const scheme = String(value || '').trim().toLowerCase()
  return SCHEME.test(scheme) ? scheme : DEFAULT_SCHEME
}

export function createPurdueLinkHandoff({ secret, now = Date.now, ttlMs = DEFAULT_TTL_MS, scheme } = {}) {
  const appScheme = normalizeScheme(scheme)
  const returnUrlBase = `${appScheme}://${RETURN_HOST}`
  const used = new Map() // jti -> expiresAt (ms)
  const sign = (payload) => createHmac('sha256', secret).update(`purdue-link-v1:${payload}`).digest('base64url')

  function requireConfig() {
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new HandoffError('Purdue linking from the app is not configured on the server.', 503, 'unconfigured')
    }
  }

  function prune() {
    const current = now()
    for (const [jti, expiresAt] of used) {
      if (current >= expiresAt) used.delete(jti)
    }
  }

  function issue(userId) {
    requireConfig()
    if (!UUID.test(String(userId || ''))) {
      throw new HandoffError('A signed-in student is required.', 401, 'unauthorized')
    }
    const issuedAt = now()
    const details = { uid: userId, jti: randomUUID(), iat: issuedAt, exp: issuedAt + ttlMs }
    const payload = Buffer.from(JSON.stringify(details)).toString('base64url')
    return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(details.exp).toISOString() }
  }

  function verify(token) {
    requireConfig()
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw invalid()
    const [payload, signature, extra] = token.split('.')
    const expected = Buffer.from(sign(payload || ''))
    const actual = Buffer.from(signature || '')
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid()
    let data
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      throw invalid()
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid()
    if (!UUID.test(String(data.uid || '')) || !UUID.test(String(data.jti || ''))) throw invalid()
    if (!Number.isFinite(data.iat) || !Number.isFinite(data.exp) || data.exp <= data.iat) throw invalid()
    if (now() >= data.exp) throw new HandoffError('This link expired. Start again from the app.', 410, 'expired')
    if (used.has(data.jti)) throw new HandoffError('This link was already used. Start again from the app.', 410, 'used')
    return { userId: data.uid, jti: data.jti, expiresAt: data.exp }
  }

  function consume(token) {
    const data = verify(token)
    prune()
    used.set(data.jti, data.expiresAt)
    return data
  }

  function returnUrl(status, params = {}) {
    const url = new URL(returnUrlBase)
    url.searchParams.set('status', status === 'ok' ? 'ok' : 'error')
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  return {
    scheme: appScheme,
    ttlMs,
    returnUrlBase,
    issue,
    verify,
    consume,
    returnUrl,
    usedCount: () => used.size,
  }
}
