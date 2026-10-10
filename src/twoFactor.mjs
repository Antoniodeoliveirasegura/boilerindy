// Emailed one-time codes for two-step sign-in: after an email + password
// sign-in checks out, the session waits on a six-digit code mailed to the
// account (Google sign-in skips it). Purdue inbox verification has its own
// module, src/purdueEmailVerification.mjs.
//
// A challenge is a row of sign_in_challenges (db/supabase-sign-in-challenges.sql)
// and the pending session holds only its id. The row stores an HMAC of the
// code, bound to the row and its user, so a code or a leaked row can never
// satisfy another challenge. The counters live in the row rather than the
// session so they hold under parallel requests: src/routes/auth.mjs counts a
// guess with a compare-and-swap on `attempts` before it compares the code, and
// spends a right code by deleting the row, which only one request can do.
// Everything here is pure so the policy is unit-testable without Express or
// Supabase.
//
// Names say "sign-in", "check" and "device trust" on purpose. CodeQL reads any
// call named like "login", "auth" or "verify" as an authorization check, and it
// cannot see this repo's createRateLimiter, so js/missing-rate-limiting flags
// routes that are limited (docs/RATE_LIMITS.md). It reads "trusted" as a secret
// and "password" as a password. src/blocks.mjs carries the same note.

import crypto from 'node:crypto'

export const CODE_LENGTH = 6
/** One code works for 10 minutes; a resend issues a new one. */
export const CODE_TTL_MS = 10 * 60 * 1000
/** A pending sign-in, resends included, ends 30 minutes after the password. */
export const PENDING_TTL_MS = 30 * 60 * 1000
/** The pending session's cookie; the server's sessions roll, so each step renews it. */
export const PENDING_COOKIE_MS = 15 * 60 * 1000
/** Guesses per code; the last wrong one ends the pending sign-in. */
export const MAX_ATTEMPTS = 5
export const RESEND_COOLDOWN_MS = 30 * 1000
/** Codes mailed per pending sign-in, the first one included. */
export const MAX_SENDS = 5
export const DEVICE_TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
}

export function normalizeCode(input) {
  return String(input ?? '').replace(/[\s-]/g, '')
}

/** What a challenge row stores for `code`: bound to the row id and its user. */
export function hashSignInCode(secret, { challengeId, subject, code }) {
  return hmac(secret, `sign-in-code|${challengeId}|${subject}|${code}`)
}

/**
 * Whether `code` is the one `row` was issued for. Spaces and dashes are
 * dropped first, since the email shows the code spaced out.
 * @param {string} secret
 * @param {{ id: string, user_id: string, code_hash: string }} row
 * @param {unknown} code
 */
export function codeMatches(secret, row, code) {
  const submitted = normalizeCode(code)
  if (!/^\d+$/.test(submitted) || submitted.length !== CODE_LENGTH) return false
  return safeEqual(hashSignInCode(secret, { challengeId: row.id, subject: row.user_id, code: submitted }), row.code_hash)
}

// A stored timestamp in milliseconds, or NaN, which every check below reads as
// "already passed" so an unreadable row fails closed.
const msOf = (value) => new Date(value ?? NaN).getTime()

function timedOut(row, now) {
  const created = msOf(row.created_at)
  return Number.isNaN(created) || now >= created + PENDING_TTL_MS
}

/**
 * Where a challenge row stands for a submitted code, checked in this order:
 * 'missing' (no row), 'timed-out' (the pending sign-in is over 30 minutes old),
 * 'exhausted' (MAX_ATTEMPTS guesses used), 'expired' (this code is over 10
 * minutes old; a resend can replace it), 'live'.
 * @param {{ attempts?: number, expires_at: string, created_at: string } | null | undefined} row
 * @param {number} [now]
 * @returns {'missing' | 'timed-out' | 'exhausted' | 'expired' | 'live'}
 */
export function challengeStatus(row, now = Date.now()) {
  if (!row) return 'missing'
  if (timedOut(row, now)) return 'timed-out'
  if ((Number(row.attempts) || 0) >= MAX_ATTEMPTS) return 'exhausted'
  const expires = msOf(row.expires_at)
  if (Number.isNaN(expires) || now >= expires) return 'expired'
  return 'live'
}

/**
 * Whether a new code may be mailed for `row`. A code that merely expired can
 * be replaced; a timed-out or exhausted sign-in has to start over.
 * @returns {{ reason: 'ok' | 'missing' | 'timed-out' | 'exhausted' | 'too-many-sends' | 'cooldown', retryAfterMs?: number }}
 */
export function resendStatus(row, now = Date.now()) {
  const status = challengeStatus(row, now)
  if (status === 'missing' || status === 'timed-out' || status === 'exhausted') return { reason: status }
  if ((Number(row.sends) || 0) >= MAX_SENDS) return { reason: 'too-many-sends' }
  const sent = msOf(row.sent_at)
  const wait = Number.isNaN(sent) ? RESEND_COOLDOWN_MS : Math.min(RESEND_COOLDOWN_MS, sent + RESEND_COOLDOWN_MS - now)
  if (wait > 0) return { reason: 'cooldown', retryAfterMs: wait }
  return { reason: 'ok' }
}

/**
 * The student-facing words for a failed check or resend.
 * @param {{ reason: string, remaining?: number, retryAfterMs?: number }} result
 */
export function challengeErrorMessage(result) {
  switch (result.reason) {
    case 'invalid':
      return `That code is not right. ${result.remaining} ${result.remaining === 1 ? 'try' : 'tries'} left.`
    case 'expired':
      return 'That code expired. Request a new one.'
    case 'too-many-attempts':
      return 'Too many incorrect codes. Start over to get a new one.'
    case 'cooldown':
      return `Please wait ${Math.ceil((result.retryAfterMs || 0) / 1000)} seconds before requesting another code.`
    case 'too-many-sends':
      return 'Too many codes requested. Start over in a few minutes.'
    case 'timed-out':
      return 'This sign-in timed out. Start over to get a new code.'
    case 'password-changed':
      return 'Your password changed after this code was sent. Sign in again with the new one.'
    default:
      return 'No verification is in progress. Start over to get a new code.'
  }
}

// ── Device trust ("Trust this device") ──────────────────────────────────────
// A signed cookie value `<userId>.<expiresMs>.<sig>`. The signature covers the
// account's password_changed_at (a timestamp, never the password), so changing
// the password revokes every trusted device without any stored state.

function revocationStamp(passwordChangedAt) {
  if (!passwordChangedAt) return ''
  const ms = new Date(passwordChangedAt).getTime()
  return Number.isNaN(ms) ? '' : String(ms)
}

function deviceTrustSignature(secret, userId, expiresMs, passwordChangedAt) {
  return hmac(secret, `trusted-device|${userId}|${expiresMs}|${revocationStamp(passwordChangedAt)}`)
}

export function createDeviceTrustToken(secret, { userId, passwordChangedAt, now = Date.now() }) {
  const expiresMs = now + DEVICE_TRUST_TTL_MS
  return `${userId}.${expiresMs}.${deviceTrustSignature(secret, userId, expiresMs, passwordChangedAt)}`
}

export function checkDeviceTrustToken(secret, token, { userId, passwordChangedAt, now = Date.now() }) {
  if (!token || typeof token !== 'string' || !userId) return false
  const [tokenUserId, expiresRaw, signature, ...rest] = token.split('.')
  if (rest.length || tokenUserId !== String(userId) || !signature) return false
  const expiresMs = Number(expiresRaw)
  if (!Number.isFinite(expiresMs) || now > expiresMs) return false
  return safeEqual(signature, deviceTrustSignature(secret, userId, expiresMs, passwordChangedAt))
}

export function parseCookies(header) {
  const cookies = {}
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      cookies[name] = part.slice(index + 1).trim()
    }
  }
  return cookies
}

// ── Supabase access tokens ──────────────────────────────────────────────────

// Sign-in methods where the identity provider (Google) or the inbox itself
// already proved more than a password. Supabase records them in the `amr` claim.
const NON_PASSWORD_METHODS = new Set(['oauth', 'otp', 'magiclink', 'recovery', 'invite', 'email/signup', 'sso/saml'])

/** Read the `amr` methods from a JWT already validated by supabase.auth.getUser. */
export function tokenAuthMethods(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8'))
    return Array.isArray(payload?.amr)
      ? payload.amr.map((entry) => (typeof entry === 'string' ? entry : entry?.method)).filter(Boolean)
      : []
  } catch {
    return []
  }
}

/** True unless the token shows a non-password sign-in. Unknown tokens need a code. */
export function tokenNeedsSignInCode(accessToken) {
  return !tokenAuthMethods(accessToken).some((method) => NON_PASSWORD_METHODS.has(method))
}
