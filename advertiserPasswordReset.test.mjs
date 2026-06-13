import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RESET_TOKEN_TTL_MS,
  hashResetToken,
  generateResetToken,
  resetTokenExpiry,
  isResetTokenExpired,
  normalizeForgotPasswordInput,
  normalizeResetPasswordInput,
} from './advertiserPasswordReset.mjs'

test('hashResetToken is deterministic and not the raw token', () => {
  const hashA = hashResetToken('abc123')
  const hashB = hashResetToken('abc123')
  assert.equal(hashA, hashB)
  assert.notEqual(hashA, 'abc123')
  assert.match(hashA, /^[0-9a-f]{64}$/) // sha256 hex
})

test('generateResetToken returns a random token whose hash matches', () => {
  const a = generateResetToken()
  const b = generateResetToken()
  assert.notEqual(a.token, b.token) // randomness
  assert.equal(a.tokenHash, hashResetToken(a.token))
  assert.ok(a.token.length >= 32)
  // base64url: no +, /, or = padding
  assert.doesNotMatch(a.token, /[+/=]/)
})

test('resetTokenExpiry is TTL in the future', () => {
  const now = 1_000_000_000_000
  const expiry = resetTokenExpiry(now)
  assert.equal(new Date(expiry).getTime(), now + RESET_TOKEN_TTL_MS)
})

test('isResetTokenExpired respects the boundary and bad input', () => {
  const now = 1_000_000_000_000
  const future = new Date(now + 60_000).toISOString()
  const past = new Date(now - 1).toISOString()
  assert.equal(isResetTokenExpired(future, now), false)
  assert.equal(isResetTokenExpired(past, now), true)
  assert.equal(isResetTokenExpired(new Date(now).toISOString(), now), true) // at boundary
  assert.equal(isResetTokenExpired('not-a-date', now), true) // invalid = treat as expired
})

test('normalizeForgotPasswordInput lowercases valid emails and rejects junk', () => {
  assert.deepEqual(normalizeForgotPasswordInput({ email: ' Brand@Co.COM ' }), { email: 'brand@co.com' })
  assert.throws(() => normalizeForgotPasswordInput({ email: 'nope' }), /valid business email/)
  assert.throws(() => normalizeForgotPasswordInput({}), /valid business email/)
})

test('normalizeResetPasswordInput requires a token and an 8+ char password', () => {
  assert.deepEqual(
    normalizeResetPasswordInput({ token: ' tok ', password: 'longenough' }),
    { token: 'tok', password: 'longenough' },
  )
  assert.throws(() => normalizeResetPasswordInput({ password: 'longenough' }), /invalid or has expired/)
  assert.throws(() => normalizeResetPasswordInput({ token: 'tok', password: 'short' }), /at least 8 characters/)
})
