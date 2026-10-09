// Emailed one-time codes for two-step sign-in: after an email + password
// sign-in checks out, the session waits on a six-digit code mailed to the
// account (Google sign-in skips it). Purdue inbox verification has its own
// module, src/purdueEmailVerification.mjs.
//
// A challenge lives in the server session (never sent to the client) and stores
// only an HMAC of the code, bound to its purpose and subject, so a code minted
// for one purpose or user can never satisfy another. Everything here is pure so
// the policy is unit-testable without Express or Supabase.

import crypto from 'node:crypto'

export const CODE_LENGTH = 6
export const CODE_TTL_MS = 10 * 60 * 1000
export const MAX_ATTEMPTS = 5
export const RESEND_COOLDOWN_MS = 30 * 1000
export const MAX_SENDS = 5
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000

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

function hashCode(secret, { purpose, subject, code }) {
  return hmac(secret, `code|${purpose}|${subject}|${code}`)
}

/**
 * Start a challenge. `extra` is stored alongside (e.g. rememberMe, the email
 * being verified) and carried through resends.
 * @returns {{ code: string, challenge: object }}
 */
export function createChallenge(secret, { purpose, subject, extra = {}, now = Date.now(), code = generateCode() }) {
  return {
    code,
    challenge: {
      ...extra,
      purpose,
      subject,
      codeHash: hashCode(secret, { purpose, subject, code }),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      sends: 1,
      sentAt: now,
    },
  }
}

/**
 * Check a submitted code. Never mutates the input; the caller persists the
 * returned `challenge` (null means discard it - the user must start over).
 * @returns {{ ok: boolean, reason?: 'missing'|'expired'|'too-many-attempts'|'invalid', remaining?: number, challenge: object|null }}
 */
export function verifyChallenge(secret, challenge, { purpose, code, now = Date.now() }) {
  if (!challenge || challenge.purpose !== purpose) return { ok: false, reason: 'missing', challenge: null }
  if (now > challenge.expiresAt) return { ok: false, reason: 'expired', challenge: null }
  if (challenge.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too-many-attempts', challenge: null }

  const submitted = normalizeCode(code)
  const matches = /^\d+$/.test(submitted)
    && submitted.length === CODE_LENGTH
    && safeEqual(hashCode(secret, { purpose, subject: challenge.subject, code: submitted }), challenge.codeHash)
  if (matches) return { ok: true, challenge: null }

  const attempts = challenge.attempts + 1
  if (attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too-many-attempts', challenge: null }
  return { ok: false, reason: 'invalid', remaining: MAX_ATTEMPTS - attempts, challenge: { ...challenge, attempts } }
}

/**
 * Issue a fresh code for an existing challenge (new expiry, attempts reset).
 * @returns {{ ok: boolean, reason?: 'missing'|'cooldown'|'too-many-sends', retryAfterMs?: number, code?: string, challenge: object|null }}
 */
export function resendChallenge(secret, challenge, { now = Date.now(), code = generateCode() } = {}) {
  if (!challenge) return { ok: false, reason: 'missing', challenge: null }
  if (challenge.sends >= MAX_SENDS) return { ok: false, reason: 'too-many-sends', challenge }
  const wait = challenge.sentAt + RESEND_COOLDOWN_MS - now
  if (wait > 0) return { ok: false, reason: 'cooldown', retryAfterMs: wait, challenge }
  const { purpose, subject } = challenge
  return {
    ok: true,
    code,
    challenge: {
      ...challenge,
      codeHash: hashCode(secret, { purpose, subject, code }),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      sends: challenge.sends + 1,
      sentAt: now,
    },
  }
}

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
    default:
      return 'No verification is in progress. Start over to get a new code.'
  }
}

// ── Trusted devices ─────────────────────────────────────────────────────────
// A signed cookie value `<userId>.<expiresMs>.<sig>`. The signature covers the
// account's password_changed_at, so changing the password revokes every
// trusted device without any stored state.

function passwordStamp(passwordChangedAt) {
  if (!passwordChangedAt) return ''
  const ms = new Date(passwordChangedAt).getTime()
  return Number.isNaN(ms) ? '' : String(ms)
}

function trustedDeviceSignature(secret, userId, expiresMs, passwordChangedAt) {
  return hmac(secret, `trusted-device|${userId}|${expiresMs}|${passwordStamp(passwordChangedAt)}`)
}

export function createTrustedDeviceToken(secret, { userId, passwordChangedAt, now = Date.now() }) {
  const expiresMs = now + TRUSTED_DEVICE_TTL_MS
  return `${userId}.${expiresMs}.${trustedDeviceSignature(secret, userId, expiresMs, passwordChangedAt)}`
}

export function verifyTrustedDeviceToken(secret, token, { userId, passwordChangedAt, now = Date.now() }) {
  if (!token || typeof token !== 'string' || !userId) return false
  const [tokenUserId, expiresRaw, signature, ...rest] = token.split('.')
  if (rest.length || tokenUserId !== String(userId) || !signature) return false
  const expiresMs = Number(expiresRaw)
  if (!Number.isFinite(expiresMs) || now > expiresMs) return false
  return safeEqual(signature, trustedDeviceSignature(secret, userId, expiresMs, passwordChangedAt))
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
export function tokenNeedsLoginCode(accessToken) {
  return !tokenAuthMethods(accessToken).some((method) => NON_PASSWORD_METHODS.has(method))
}
