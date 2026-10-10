import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_TTL_MS,
  DEVICE_TRUST_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS,
  PENDING_TTL_MS,
  RESEND_COOLDOWN_MS,
  challengeErrorMessage,
  challengeStatus,
  checkDeviceTrustToken,
  codeMatches,
  createDeviceTrustToken,
  generateCode,
  hashSignInCode,
  parseCookies,
  resendStatus,
  tokenAuthMethods,
  tokenNeedsSignInCode,
} from '../src/twoFactor.mjs'

const SECRET = 'test-secret-that-is-long-enough-for-hmac'
const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

// A sign_in_challenges row as the routes write it, for `code`, created at NOW.
function row(code = '123456', fields = {}) {
  const id = 'challenge-1'
  const userId = 'user-1'
  return {
    id,
    user_id: userId,
    code_hash: hashSignInCode(SECRET, { challengeId: id, subject: userId, code }),
    expires_at: iso(NOW + CODE_TTL_MS),
    attempts: 0,
    sends: 1,
    sent_at: iso(NOW),
    created_at: iso(NOW),
    ...fields,
  }
}

test('generated codes are six digits', () => {
  for (let i = 0; i < 50; i += 1) assert.match(generateCode(), /^\d{6}$/)
})

test('the row stores a hash, never the code', () => {
  assert.ok(!JSON.stringify(row('123456')).includes('123456'))
})

test('the right code matches, tolerating spaces and dashes; anything else does not', () => {
  const challenge = row('123456')
  assert.equal(codeMatches(SECRET, challenge, '123456'), true)
  assert.equal(codeMatches(SECRET, challenge, ' 123-456 '), true)
  assert.equal(codeMatches(SECRET, challenge, 123456), true, 'a client may send the digits as a JSON number')
  for (const wrong of ['000000', '12345', '1234567', 'abcdef', '', null, undefined, 1234567]) {
    assert.equal(codeMatches(SECRET, challenge, wrong), false, String(wrong))
  }
})

test('a code is bound to its row, its user and the secret', () => {
  const challenge = row('123456')
  assert.equal(codeMatches(SECRET, { ...challenge, id: 'challenge-2' }, '123456'), false)
  assert.equal(codeMatches(SECRET, { ...challenge, user_id: 'user-2' }, '123456'), false)
  assert.equal(codeMatches('another-secret', challenge, '123456'), false)
})

test('challengeStatus: missing, timed out, exhausted, expired, live', () => {
  assert.equal(challengeStatus(null, NOW), 'missing')
  assert.equal(challengeStatus(row(), NOW), 'live')
  assert.equal(challengeStatus(row('123456', { attempts: MAX_ATTEMPTS - 1 }), NOW), 'live')
  assert.equal(challengeStatus(row('123456', { attempts: MAX_ATTEMPTS }), NOW), 'exhausted')
  assert.equal(challengeStatus(row(), NOW + CODE_TTL_MS), 'expired')
  assert.equal(challengeStatus(row(), NOW + PENDING_TTL_MS), 'timed-out')
  // Postgres hands timestamps back in its own format.
  assert.equal(challengeStatus(row('123456', { created_at: '2026-10-09T12:00:00.000000+00:00' }), NOW), 'live')
})

test('challengeStatus: the whole sign-in times out even when a resend renewed the code', () => {
  const renewed = row('123456', { expires_at: iso(NOW + PENDING_TTL_MS + CODE_TTL_MS) })
  assert.equal(challengeStatus(renewed, NOW + PENDING_TTL_MS - 1), 'live')
  assert.equal(challengeStatus(renewed, NOW + PENDING_TTL_MS), 'timed-out')
})

test('challengeStatus: an unreadable timestamp fails closed', () => {
  assert.equal(challengeStatus(row('123456', { created_at: 'garbage' }), NOW), 'timed-out')
  assert.equal(challengeStatus(row('123456', { expires_at: null }), NOW), 'expired')
})

test('resendStatus: a cooldown, then a new code, until the send budget is spent', () => {
  assert.deepEqual(resendStatus(row(), NOW + 1000), { reason: 'cooldown', retryAfterMs: RESEND_COOLDOWN_MS - 1000 })
  assert.deepEqual(resendStatus(row(), NOW + RESEND_COOLDOWN_MS), { reason: 'ok' })
  assert.deepEqual(resendStatus(row('123456', { sends: MAX_SENDS }), NOW + RESEND_COOLDOWN_MS), { reason: 'too-many-sends' })
})

test('resendStatus: an expired code can be replaced; a timed-out or exhausted sign-in cannot', () => {
  assert.deepEqual(resendStatus(row(), NOW + CODE_TTL_MS), { reason: 'ok' })
  assert.deepEqual(resendStatus(row(), NOW + PENDING_TTL_MS), { reason: 'timed-out' })
  assert.deepEqual(resendStatus(row('123456', { attempts: MAX_ATTEMPTS }), NOW + RESEND_COOLDOWN_MS), { reason: 'exhausted' })
  assert.deepEqual(resendStatus(null, NOW), { reason: 'missing' })
})

test('resendStatus: a sent_at in the future never asks for more than the cooldown', () => {
  const skewed = row('123456', { sent_at: iso(NOW + 60 * 60 * 1000) })
  assert.deepEqual(resendStatus(skewed, NOW), { reason: 'cooldown', retryAfterMs: RESEND_COOLDOWN_MS })
})

test('every reason has its own words', () => {
  assert.equal(challengeErrorMessage({ reason: 'invalid', remaining: 1 }), 'That code is not right. 1 try left.')
  assert.equal(challengeErrorMessage({ reason: 'invalid', remaining: 3 }), 'That code is not right. 3 tries left.')
  assert.equal(challengeErrorMessage({ reason: 'cooldown', retryAfterMs: 12_001 }), 'Please wait 13 seconds before requesting another code.')
  const reasons = ['expired', 'too-many-attempts', 'too-many-sends', 'timed-out', 'password-changed', 'missing']
  const messages = reasons.map((reason) => challengeErrorMessage({ reason }))
  assert.equal(new Set(messages).size, reasons.length)
})

test('a trusted-device token is valid only for its user, before expiry', () => {
  const token = createDeviceTrustToken(SECRET, { userId: 'user-1', passwordChangedAt: null, now: NOW })
  assert.equal(checkDeviceTrustToken(SECRET, token, { userId: 'user-1', passwordChangedAt: null, now: NOW }), true)
  assert.equal(checkDeviceTrustToken(SECRET, token, { userId: 'user-2', passwordChangedAt: null, now: NOW }), false)
  assert.equal(
    checkDeviceTrustToken(SECRET, token, { userId: 'user-1', passwordChangedAt: null, now: NOW + DEVICE_TRUST_TTL_MS + 1 }),
    false,
  )
})

test('changing the password revokes trusted devices', () => {
  const token = createDeviceTrustToken(SECRET, { userId: 'user-1', passwordChangedAt: '2026-10-01T00:00:00.000Z', now: NOW })
  // Same instant in Postgres format still verifies.
  assert.equal(
    checkDeviceTrustToken(SECRET, token, { userId: 'user-1', passwordChangedAt: '2026-10-01T00:00:00.000000+00:00', now: NOW }),
    true,
  )
  assert.equal(
    checkDeviceTrustToken(SECRET, token, { userId: 'user-1', passwordChangedAt: '2026-10-09T00:00:00.000Z', now: NOW }),
    false,
  )
})

test('tampered or malformed trusted-device tokens are rejected', () => {
  const token = createDeviceTrustToken(SECRET, { userId: 'user-1', now: NOW })
  const [userId, , sig] = token.split('.')
  const extended = `${userId}.${NOW + DEVICE_TRUST_TTL_MS * 10}.${sig}`
  assert.equal(checkDeviceTrustToken(SECRET, extended, { userId: 'user-1', now: NOW }), false)
  for (const bad of ['', 'garbage', 'a.b.c.d', null, undefined]) {
    assert.equal(checkDeviceTrustToken(SECRET, bad, { userId: 'user-1', now: NOW }), false)
  }
})

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`
}

test('password-only Supabase tokens need a code; Google and email-link tokens do not', () => {
  const password = fakeJwt({ amr: [{ method: 'password', timestamp: 1 }] })
  const google = fakeJwt({ amr: [{ method: 'oauth', timestamp: 1 }] })
  const recovery = fakeJwt({ amr: [{ method: 'recovery', timestamp: 1 }] })
  assert.deepEqual(tokenAuthMethods(password), ['password'])
  assert.equal(tokenNeedsSignInCode(password), true)
  assert.equal(tokenNeedsSignInCode(google), false)
  assert.equal(tokenNeedsSignInCode(recovery), false)
})

test('tokens without a readable amr claim need a code', () => {
  assert.equal(tokenNeedsSignInCode('not-a-jwt'), true)
  assert.equal(tokenNeedsSignInCode(fakeJwt({ sub: 'x' })), true)
})

test('parseCookies reads a Cookie header', () => {
  assert.deepEqual(parseCookies('pih.sid=abc; pih.td=user-1.123.sig%3D'), { 'pih.sid': 'abc', 'pih.td': 'user-1.123.sig=' })
  assert.deepEqual(parseCookies(undefined), {})
})
