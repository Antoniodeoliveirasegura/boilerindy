import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCasServiceUrl,
  casStateMatches,
  createCasState,
  spendCasState,
  takeCasState,
} from '../src/casLinkState.mjs'

// Issue #293: the website Purdue CAS callback is bound to the session that
// started the link by a single-use nonce. server.mjs starts listening on
// import, so the pieces it wires together are pinned here.

const BASE = 'https://api.example.test'

test('a fresh state is 32 hex characters and takes its bytes from the generator', () => {
  const state = createCasState()
  assert.match(state, /^[0-9a-f]{32}$/)
  assert.notEqual(createCasState(), state, 'two calls do not repeat')

  let asked = 0
  const pinned = createCasState((size) => {
    asked = size
    return Buffer.alloc(size, 0xab)
  })
  assert.equal(asked, 16)
  assert.equal(pinned, 'ab'.repeat(16))
})

test('takeCasState returns the value once and deletes it', () => {
  const session = { userId: 'u1', casState: 'abc123' }
  assert.equal(takeCasState(session), 'abc123')
  assert.equal('casState' in session, false)
  assert.equal(session.userId, 'u1', 'the rest of the session is untouched')
  assert.equal(takeCasState(session), '', 'second take finds nothing')
})

test('takeCasState tolerates a session without a nonce, and no session at all', () => {
  assert.equal(takeCasState({ userId: 'u1' }), '')
  assert.equal(takeCasState(undefined), '')
  assert.equal(takeCasState(null), '')
  // A non-string value is dropped, never returned.
  const session = { casState: 12345 }
  assert.equal(takeCasState(session), '')
  assert.equal('casState' in session, false)
})

test('casStateMatches accepts only an identical non-empty string', () => {
  const state = 'ab'.repeat(16)
  assert.equal(casStateMatches(state, state), true)
  assert.equal(casStateMatches(state, 'cd'.repeat(16)), false, 'same length, different value')
  assert.equal(casStateMatches(state, state.slice(1)), false, 'different length')
  assert.equal(casStateMatches(state, ''), false, 'empty provided')
  assert.equal(casStateMatches('', ''), false, 'both empty never match')
  assert.equal(casStateMatches(state, undefined), false)
  assert.equal(casStateMatches(undefined, state), false)
  assert.equal(casStateMatches(state, [state]), false, 'a repeated query key is an array')
  // Same string length, different byte length: must not throw.
  const multiByte = `${'a'.repeat(31)}é`
  assert.equal(multiByte.length, state.length)
  assert.equal(casStateMatches(state, multiByte), false)
})

test('spendCasState links on a match and the nonce cannot be replayed', () => {
  const state = createCasState()
  const session = { userId: 'u1', casState: state }
  assert.equal(spendCasState(session, state), state)
  assert.equal(spendCasState(session, state), null, 'the same callback URL a second time is refused')
})

test('spendCasState refuses a wrong or missing state and spends the nonce anyway', () => {
  const state = createCasState()

  const wrong = { casState: state }
  assert.equal(spendCasState(wrong, createCasState()), null)
  assert.equal('casState' in wrong, false, 'a forged callback burns the nonce')
  assert.equal(spendCasState(wrong, state), null, 'the real callback after a forged one also fails')

  const missing = { casState: state }
  assert.equal(spendCasState(missing, undefined), null)
  assert.equal('casState' in missing, false)

  assert.equal(spendCasState({ casState: state }, [state]), null, 'an array ?state= is refused')
  assert.equal(spendCasState({}, state), null, 'a session that never started a link')
  assert.equal(spendCasState(undefined, state), null)
})

test('the native service URL is unchanged and never carries a state', () => {
  const token = 'eyJ1aWQiOiJ4In0.c2ln-_'
  const expected = `${BASE}/auth/purdue/callback?t=${encodeURIComponent(token)}`
  assert.equal(buildCasServiceUrl(BASE, { token }), expected)
  assert.equal(buildCasServiceUrl(BASE, { token, state: 'ab'.repeat(16) }), expected)
  assert.equal(buildCasServiceUrl(BASE, { token, nextPath: '/setup' }), expected, 't wins over next')
})

test('the website service URL carries the next path and, when given, the state', () => {
  const state = 'ab'.repeat(16)
  assert.equal(
    buildCasServiceUrl(BASE, { nextPath: '/setup?tab=a&b=1', state }),
    `${BASE}/auth/purdue/callback?next=%2Fsetup%3Ftab%3Da%26b%3D1&state=${state}`,
  )
  assert.equal(
    buildCasServiceUrl(BASE, { nextPath: '/setup' }),
    `${BASE}/auth/purdue/callback?next=%2Fsetup`,
    'no state, no parameter',
  )
  assert.equal(buildCasServiceUrl(BASE, { nextPath: '/setup', state: '' }), `${BASE}/auth/purdue/callback?next=%2Fsetup`)
})
