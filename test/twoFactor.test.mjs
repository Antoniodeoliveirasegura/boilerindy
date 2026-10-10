import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_TTL_MS,
  DEVICE_TRUST_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS,
  RESEND_COOLDOWN_MS,
  checkChallenge,
  checkDeviceTrustToken,
  createChallenge,
  createDeviceTrustToken,
  generateCode,
  parseCookies,
  resendChallenge,
  tokenAuthMethods,
  tokenNeedsSignInCode,
} from '../src/twoFactor.mjs'

const SECRET = 'test-secret-that-is-long-enough-for-hmac'
const NOW = Date.parse('2026-10-09T12:00:00.000Z')

function loginChallenge(code = '123456') {
  return createChallenge(SECRET, { purpose: 'login', subject: 'user-1', code, now: NOW }).challenge
}

test('generated codes are six digits', () => {
  for (let i = 0; i < 50; i += 1) assert.match(generateCode(), /^\d{6}$/)
})

test('the challenge stores a hash, never the code', () => {
  const challenge = loginChallenge('123456')
  assert.ok(!JSON.stringify(challenge).includes('123456'))
  assert.equal(challenge.expiresAt, NOW + CODE_TTL_MS)
})

test('the right code verifies, tolerating spaces and dashes', () => {
  const challenge = loginChallenge('123456')
  assert.equal(checkChallenge(SECRET, challenge, { purpose: 'login', code: '123456', now: NOW }).ok, true)
  assert.equal(checkChallenge(SECRET, challenge, { purpose: 'login', code: ' 123-456 ', now: NOW }).ok, true)
})

test('a wrong code counts an attempt and keeps the challenge', () => {
  const result = checkChallenge(SECRET, loginChallenge('123456'), { purpose: 'login', code: '000000', now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid')
  assert.equal(result.remaining, MAX_ATTEMPTS - 1)
  assert.equal(result.challenge.attempts, 1)
})

test('the last allowed wrong attempt discards the challenge', () => {
  let challenge = loginChallenge('123456')
  let result
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    result = checkChallenge(SECRET, challenge, { purpose: 'login', code: '000000', now: NOW })
    challenge = result.challenge
  }
  assert.equal(result.reason, 'too-many-attempts')
  assert.equal(result.challenge, null)
})

test('an expired code is rejected even if correct', () => {
  const result = checkChallenge(SECRET, loginChallenge('123456'), {
    purpose: 'login',
    code: '123456',
    now: NOW + CODE_TTL_MS + 1,
  })
  assert.equal(result.reason, 'expired')
})

test('a code cannot cross purposes, subjects, or secrets', () => {
  const challenge = loginChallenge('123456')
  assert.equal(checkChallenge(SECRET, challenge, { purpose: 'purdue-link', code: '123456', now: NOW }).reason, 'missing')
  const otherUser = { ...challenge, subject: 'user-2' }
  assert.equal(checkChallenge(SECRET, otherUser, { purpose: 'login', code: '123456', now: NOW }).ok, false)
  assert.equal(checkChallenge('another-secret', challenge, { purpose: 'login', code: '123456', now: NOW }).ok, false)
})

test('no pending challenge reports missing', () => {
  assert.equal(checkChallenge(SECRET, undefined, { purpose: 'login', code: '123456', now: NOW }).reason, 'missing')
})

test('resend enforces a cooldown, then rotates the code', () => {
  const challenge = loginChallenge('123456')
  const early = resendChallenge(SECRET, challenge, { now: NOW + 1000, code: '654321' })
  assert.equal(early.reason, 'cooldown')

  const later = resendChallenge(SECRET, { ...challenge, attempts: 3 }, { now: NOW + RESEND_COOLDOWN_MS, code: '654321' })
  assert.equal(later.ok, true)
  assert.equal(later.challenge.attempts, 0)
  assert.equal(later.challenge.sends, 2)
  const at = NOW + RESEND_COOLDOWN_MS
  assert.equal(checkChallenge(SECRET, later.challenge, { purpose: 'login', code: '123456', now: at }).ok, false)
  assert.equal(checkChallenge(SECRET, later.challenge, { purpose: 'login', code: '654321', now: at }).ok, true)
})

test('resend stops after the send budget', () => {
  const challenge = { ...loginChallenge(), sends: MAX_SENDS }
  assert.equal(resendChallenge(SECRET, challenge, { now: NOW + RESEND_COOLDOWN_MS }).reason, 'too-many-sends')
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
