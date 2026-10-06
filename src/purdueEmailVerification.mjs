import crypto from 'node:crypto'

// Purdue email-code verification (issue #181): a student proves they own a
// @purdue.edu mailbox by typing a six-digit code mailed to it, and the address
// is then linked through linkPurdueIdentity (src/purdueIdentity.mjs), the same function
// the CAS callback and the dev mock use. Pure, so every rule is unit-tested
// without the database or an email provider; the three routes are in
// src/routes/purdueEmail.mjs, the table in db/supabase-purdue-email-verification.sql.
//
// Only a hash of the code is stored (purdue_email_challenges.code_hash), and
// the hash covers the challenge's id, so a leaked row cannot be replayed and a
// hash is useless outside its own challenge. Mailbox ownership is all this
// proves: it signs nobody in and reads no Purdue data.

export const PURDUE_EMAIL_DOMAIN = 'purdue.edu'
/** A code works for 10 minutes. */
export const CODE_TTL_MS = 10 * 60 * 1000
/** Wrong codes allowed per challenge; the next request starts over. */
export const MAX_ATTEMPTS = 5
/** A new code can be requested once a minute. */
export const RESEND_COOLDOWN_MS = 60 * 1000

// RFC 5321 caps a path at 254 characters. The local part is plain letters,
// digits, dots, underscores and hyphens: a Purdue career account has no plus
// tags, and allowing them would let one mailbox verify two accounts.
const MAX_EMAIL_LENGTH = 254
const LOCAL_PART = /^[a-z0-9._-]{1,64}$/
const CODE_DIGITS = 6

/**
 * What linkPurdueIdentity throws when the profile already holds a different
 * Purdue address (#293). Shared so the request route refuses with the same
 * words before any code is sent.
 */
export const LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE =
  'Your BoilerIndy profile is already linked to a different Purdue account. '
  + 'Contact support to release that link before linking another one.'

/**
 * The address, lowercased and trimmed, when it is a Purdue mailbox this flow
 * accepts: exactly @purdue.edu (no subdomain or lookalike), a plain local part.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizePurdueEmail(value) {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (email.length > MAX_EMAIL_LENGTH) return null
  const parts = email.split('@')
  if (parts.length !== 2) return null
  const [local, domain] = parts
  if (domain !== PURDUE_EMAIL_DOMAIN || !LOCAL_PART.test(local)) return null
  return email
}

/**
 * The six digits a student typed, or null. Spaces are dropped, since the
 * email shows the code spaced out.
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseVerificationCode(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const code = String(value).replace(/\s+/g, '')
  return /^\d{6}$/.test(code) ? code : null
}

/** A uniformly random six-digit code, leading zeros kept. */
export function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0')
}

/**
 * SHA-256 hex of `${challengeId}:${code}`: what the table stores and verify
 * compares against.
 * @param {string} challengeId
 * @param {string} code
 */
export function hashCode(challengeId, code) {
  return crypto.createHash('sha256').update(`${challengeId}:${code}`).digest('hex')
}

/** ISO expiry for a code sent at `now` (milliseconds). */
export function challengeExpiry(now = Date.now()) {
  return new Date(now + CODE_TTL_MS).toISOString()
}

/** True when `expiresAt` is unreadable or at or before `now`. */
export function isChallengeExpired(expiresAt, now = Date.now()) {
  const expiry = new Date(expiresAt ?? NaN).getTime()
  return Number.isNaN(expiry) || expiry <= now
}

/**
 * Whole seconds until another code may be requested, counted from the
 * student's newest challenge (spent or not); 0 when there is none or it is a
 * minute old. Never more than a minute, whatever the stored clock says.
 * @param {string | null | undefined} lastCreatedAt
 * @param {number} [now]
 */
export function cooldownRemainingSeconds(lastCreatedAt, now = Date.now()) {
  const created = new Date(lastCreatedAt ?? NaN).getTime()
  if (Number.isNaN(created)) return 0
  const remaining = Math.min(RESEND_COOLDOWN_MS, created + RESEND_COOLDOWN_MS - now)
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

/** Wrong codes the challenge still allows. */
export function attemptsLeft(challenge) {
  return Math.max(0, MAX_ATTEMPTS - (Number(challenge?.attempts) || 0))
}

function sameHash(a, b) {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

/**
 * What a submitted code means for the student's newest challenge, checked in
 * this order: 'none' (no challenge), 'consumed' (already used), 'expired',
 * 'exhausted' (MAX_ATTEMPTS wrong codes), 'wrong', 'ok'.
 * @param {{ id: string, code_hash: string, expires_at: string, attempts?: number, consumed_at?: string | null } | null | undefined} challenge
 * @param {string} code
 * @param {number} [now]
 * @returns {'none' | 'consumed' | 'expired' | 'exhausted' | 'wrong' | 'ok'}
 */
export function evaluateChallenge(challenge, code, now = Date.now()) {
  if (!challenge) return 'none'
  if (challenge.consumed_at) return 'consumed'
  if (isChallengeExpired(challenge.expires_at, now)) return 'expired'
  if (attemptsLeft(challenge) === 0) return 'exhausted'
  return sameHash(hashCode(challenge.id, code), challenge.code_hash) ? 'ok' : 'wrong'
}
