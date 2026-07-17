import test from 'node:test'
import assert from 'node:assert/strict'
import { isSessionStale } from '../src/sessionFreshness.mjs'

test('no recorded password change is never stale', () => {
  assert.equal(isSessionStale(null, '2026-07-17T02:00:00.000Z'), false)
  assert.equal(isSessionStale(undefined, undefined), false)
})

test('a password change with no session establishment time is stale (pre-feature session)', () => {
  assert.equal(isSessionStale('2026-07-17T02:00:00.000Z', null), true)
  assert.equal(isSessionStale('2026-07-17T02:00:00.000Z', undefined), true)
})

test('session established after the password change survives', () => {
  assert.equal(
    isSessionStale('2026-07-17T02:00:00.000Z', '2026-07-17T02:00:01.000Z'),
    false,
  )
})

test('session established before the password change is stale', () => {
  assert.equal(
    isSessionStale('2026-07-17T02:00:01.000Z', '2026-07-17T02:00:00.000Z'),
    true,
  )
})

test('compares by parsed time across differing string formats', () => {
  // Postgres timestamptz (microseconds + +00:00) vs JS toISOString (ms + Z),
  // same instant -> not newer -> not stale.
  assert.equal(
    isSessionStale('2026-07-17T02:00:00.000000+00:00', '2026-07-17T02:00:00.000Z'),
    false,
  )
  // Postgres value one second later -> stale.
  assert.equal(
    isSessionStale('2026-07-17T02:00:01.000000+00:00', '2026-07-17T02:00:00.000Z'),
    true,
  )
})

test('unparseable input fails open (does not lock the user out)', () => {
  assert.equal(isSessionStale('not-a-date', '2026-07-17T02:00:00.000Z'), false)
  assert.equal(isSessionStale('2026-07-17T02:00:00.000Z', 'garbage'), false)
})
