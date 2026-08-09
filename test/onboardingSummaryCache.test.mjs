import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnboardingSummaryCache } from '../src/onboardingSummaryCache.mjs'

// Issue #111 (item 6): cache the two onboarding count queries per user, with
// invalidation on every write that changes them and a TTL backstop. `now` and
// the generation are injectable so these tests never touch the wall clock.

const COUNTS = { linkedSourceCount: 2, classCount: 5 }

test('get returns null before anything is cached', () => {
  const cache = createOnboardingSummaryCache()
  assert.equal(cache.get('u1'), null)
})

test('set then get returns the cached counts', () => {
  const cache = createOnboardingSummaryCache()
  cache.set('u1', COUNTS, undefined, 1000)
  assert.deepEqual(cache.get('u1', 1000), { linkedSourceCount: 2, classCount: 5 })
})

test('entries expire at the TTL boundary', () => {
  const cache = createOnboardingSummaryCache({ ttlMs: 60_000 })
  cache.set('u1', COUNTS, undefined, 1000)
  assert.deepEqual(cache.get('u1', 1000 + 59_999), COUNTS) // still live
  assert.equal(cache.get('u1', 1000 + 60_000), null) // expired
})

test('invalidate drops the entry immediately', () => {
  const cache = createOnboardingSummaryCache()
  cache.set('u1', COUNTS, undefined, 1000)
  cache.invalidate('u1')
  assert.equal(cache.get('u1', 1000), null)
})

test('a set whose generation an invalidation superseded is dropped (read-during-write)', () => {
  const cache = createOnboardingSummaryCache()
  // Reader captures the generation, then a mutation invalidates mid-flight.
  const gen = cache.generation('u1')
  cache.invalidate('u1')
  cache.set('u1', COUNTS, gen, 1000) // stale snapshot: must not be cached
  assert.equal(cache.get('u1', 1000), null)
})

test('a set with the current generation is stored', () => {
  const cache = createOnboardingSummaryCache()
  const gen = cache.generation('u1')
  cache.set('u1', COUNTS, gen, 1000)
  assert.deepEqual(cache.get('u1', 1000), COUNTS)
})

test('multiple invalidations keep advancing the generation', () => {
  const cache = createOnboardingSummaryCache()
  const gen0 = cache.generation('u1')
  cache.invalidate('u1')
  cache.invalidate('u1')
  cache.set('u1', COUNTS, gen0, 1000) // two generations behind
  assert.equal(cache.get('u1', 1000), null)
})

test('a fresh set after invalidation caches again (self-heals)', () => {
  const cache = createOnboardingSummaryCache()
  cache.set('u1', COUNTS, undefined, 1000)
  cache.invalidate('u1')
  const gen = cache.generation('u1')
  cache.set('u1', { linkedSourceCount: 3, classCount: 9 }, gen, 2000)
  assert.deepEqual(cache.get('u1', 2000), { linkedSourceCount: 3, classCount: 9 })
})

test('falsy userId is a no-op for get and set', () => {
  const cache = createOnboardingSummaryCache()
  assert.equal(cache.get(null), null)
  cache.set(undefined, COUNTS)
  cache.set('', COUNTS)
  assert.equal(cache.size, 0)
})

test('missing counts default to zero', () => {
  const cache = createOnboardingSummaryCache()
  cache.set('u1', {}, undefined, 1000)
  assert.deepEqual(cache.get('u1', 1000), { linkedSourceCount: 0, classCount: 0 })
})

test('maxEntries bound keeps the cache from growing without limit', () => {
  const cache = createOnboardingSummaryCache({ maxEntries: 2 })
  cache.set('u1', COUNTS, undefined, 1000)
  cache.set('u2', COUNTS, undefined, 1000)
  cache.set('u3', COUNTS, undefined, 1000) // trips the bound
  assert.ok(cache.size <= 2)
  assert.deepEqual(cache.get('u3', 1000), COUNTS) // the newest still lands
})
