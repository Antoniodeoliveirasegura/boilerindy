import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPurdueLinkHandoff,
  normalizeScheme,
  HandoffError,
  DEFAULT_SCHEME,
  DEFAULT_TTL_MS,
} from '../src/purdueLinkHandoff.mjs'

const SECRET = 'x'.repeat(48)
const USER = '4f2a5c6e-1b2c-4d3e-9f8a-7b6c5d4e3f2a'

function make(overrides = {}) {
  let current = Date.UTC(2026, 8, 11, 15, 0, 0)
  const handoff = createPurdueLinkHandoff({ secret: SECRET, now: () => current, ...overrides })
  return { handoff, tick: (ms) => { current += ms } }
}

function expectHandoff(fn, status, reason) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof HandoffError, `expected HandoffError, got ${error?.constructor?.name}`)
    assert.equal(error.status, status)
    assert.equal(error.reason, reason)
    return true
  })
}

test('issue and verify round-trip the user id with a 10 minute expiry', () => {
  const { handoff } = make()
  const { token, expiresAt } = handoff.issue(USER)
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.equal(expiresAt, new Date(Date.UTC(2026, 8, 11, 15, 10, 0)).toISOString())
  const data = handoff.verify(token)
  assert.equal(data.userId, USER)
  assert.match(data.jti, /^[a-f0-9-]{36}$/)
  assert.equal(data.expiresAt, Date.UTC(2026, 8, 11, 15, 10, 0))
  assert.equal(handoff.ttlMs, DEFAULT_TTL_MS)
})

test('verify does not consume; consume makes the token single use', () => {
  const { handoff } = make()
  const { token } = handoff.issue(USER)
  handoff.verify(token)
  handoff.verify(token)
  assert.equal(handoff.consume(token).userId, USER)
  assert.equal(handoff.usedCount(), 1)
  expectHandoff(() => handoff.verify(token), 410, 'used')
  expectHandoff(() => handoff.consume(token), 410, 'used')
})

test('an expired token is rejected and pruned from the used set', () => {
  const { handoff, tick } = make()
  const { token } = handoff.issue(USER)
  handoff.consume(token)
  assert.equal(handoff.usedCount(), 1)
  tick(DEFAULT_TTL_MS)
  expectHandoff(() => handoff.verify(token), 410, 'expired')
  // A later consume of a fresh token sweeps the expired id.
  handoff.consume(handoff.issue(USER).token)
  assert.equal(handoff.usedCount(), 1)
})

test('tampered, foreign, malformed and oversized tokens are invalid', async () => {
  const { handoff } = make()
  const other = createPurdueLinkHandoff({ secret: 'y'.repeat(48) })
  const { token } = handoff.issue(USER)
  const [payload, signature] = token.split('.')
  expectHandoff(() => handoff.verify(`${payload}.${signature.slice(0, -2)}AA`), 400, 'invalid')
  expectHandoff(() => handoff.verify(other.issue(USER).token), 400, 'invalid')
  expectHandoff(() => handoff.verify(`${token}.extra`), 400, 'invalid')
  expectHandoff(() => handoff.verify('not-a-token'), 400, 'invalid')
  expectHandoff(() => handoff.verify(''), 400, 'invalid')
  expectHandoff(() => handoff.verify(undefined), 400, 'invalid')
  expectHandoff(() => handoff.verify('a'.repeat(2000)), 400, 'invalid')
  // A correctly signed payload that is not a token object is still invalid.
  const forged = Buffer.from(JSON.stringify({ uid: 'not-a-uuid', jti: 'x', iat: 1, exp: 2 })).toString('base64url')
  const { createHmac } = await import('node:crypto')
  const sig = createHmac('sha256', SECRET).update(`purdue-link-v1:${forged}`).digest('base64url')
  expectHandoff(() => handoff.verify(`${forged}.${sig}`), 400, 'invalid')
})

test('issue requires a uuid user id and a configured secret', () => {
  const { handoff } = make()
  expectHandoff(() => handoff.issue('me'), 401, 'unauthorized')
  expectHandoff(() => handoff.issue(''), 401, 'unauthorized')
  const short = createPurdueLinkHandoff({ secret: 'too-short' })
  expectHandoff(() => short.issue(USER), 503, 'unconfigured')
  expectHandoff(() => short.verify('anything'), 503, 'unconfigured')
  const missing = createPurdueLinkHandoff({})
  expectHandoff(() => missing.issue(USER), 503, 'unconfigured')
})

test('returnUrl builds the app deep link from a validated scheme only', () => {
  const { handoff } = make()
  assert.equal(handoff.scheme, DEFAULT_SCHEME)
  assert.equal(handoff.returnUrlBase, 'boilerindyapp://purdue-linked')
  assert.equal(handoff.returnUrl('ok'), 'boilerindyapp://purdue-linked?status=ok')
  assert.equal(
    handoff.returnUrl('error', { reason: 'expired', message: 'This link expired.', empty: '', gone: null }),
    'boilerindyapp://purdue-linked?status=error&reason=expired&message=This+link+expired.',
  )
  assert.equal(handoff.returnUrl('anything-else'), 'boilerindyapp://purdue-linked?status=error')
  const custom = createPurdueLinkHandoff({ secret: SECRET, scheme: 'BoilerIndy.Beta' })
  assert.equal(custom.returnUrlBase, 'boilerindy.beta://purdue-linked')
})

test('normalizeScheme rejects anything that could redirect elsewhere', () => {
  assert.equal(normalizeScheme('boilerindyapp'), 'boilerindyapp')
  assert.equal(normalizeScheme(' BoilerIndyApp '), 'boilerindyapp')
  assert.equal(normalizeScheme('https://evil.example'), DEFAULT_SCHEME)
  assert.equal(normalizeScheme('java script'), DEFAULT_SCHEME)
  assert.equal(normalizeScheme('1abc'), DEFAULT_SCHEME)
  assert.equal(normalizeScheme(''), DEFAULT_SCHEME)
  assert.equal(normalizeScheme(undefined), DEFAULT_SCHEME)
  assert.equal(normalizeScheme('a'.repeat(80)), DEFAULT_SCHEME)
})
