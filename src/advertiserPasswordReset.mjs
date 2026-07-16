import crypto from 'node:crypto'
import { ADVERTISER_PASSWORD_MIN_LENGTH, normalizeAdvertiserEmail } from './advertiserAuth.mjs'

// Pure logic for the advertiser self-serve password reset (forgot-password).
// Kept out of server.mjs so it can be unit-tested without a live Supabase or
// email provider. The DB writes, email send, and session handling stay in the
// server (imperative shell); this module only generates/validates tokens and
// shapes the data. Mirrors advertiserAuth.mjs's split.
//
// Token scheme: a 32-byte URL-safe random token is emailed to the advertiser;
// only its SHA-256 hash is stored (advertiser_password_resets.token_hash), so a
// leaked DB row cannot be replayed. Tokens are single-use and expire after 1h.

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour, matches the student flow
export const RESET_TOKEN_BYTES = 32

/** SHA-256 hex of a reset token. Deterministic - used to look up the stored row. */
export function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

/**
 * Mint a new reset token. Returns the raw token (goes in the email link, never
 * stored) and its hash (stored in the DB).
 * @returns {{ token: string, tokenHash: string }}
 */
export function generateResetToken() {
  const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url')
  return { token, tokenHash: hashResetToken(token) }
}

/** ISO expiry timestamp for a freshly minted token. */
export function resetTokenExpiry(now = Date.now()) {
  return new Date(now + RESET_TOKEN_TTL_MS).toISOString()
}

/** True when a stored token's expires_at is at or before `now`. */
export function isResetTokenExpired(expiresAt, now = Date.now()) {
  const expiryMs = new Date(expiresAt).getTime()
  if (Number.isNaN(expiryMs)) return true
  return expiryMs <= now
}

/**
 * Normalize + validate a forgot-password request. Only the email shape is
 * checked here; whether the account exists is decided by the caller (and never
 * leaked to the client).
 * @returns {{ email: string }}
 * @throws {Error} when the email is obviously invalid
 */
export function normalizeForgotPasswordInput(input = {}) {
  const email = normalizeAdvertiserEmail(input.email)
  if (email.length < 3 || email.length > 320 || !email.includes('@') || /\s/.test(email)) {
    throw new Error('Enter a valid business email.')
  }
  return { email }
}

/**
 * Validate the new password + token on a reset submission.
 * @returns {{ token: string, password: string }}
 * @throws {Error} when the token is missing or the password is too short
 */
export function normalizeResetPasswordInput(input = {}) {
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!token) {
    throw new Error('This reset link is invalid or has expired.')
  }
  const password = typeof input.password === 'string' ? input.password : ''
  if (password.length < ADVERTISER_PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${ADVERTISER_PASSWORD_MIN_LENGTH} characters.`)
  }
  return { token, password }
}
