import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateProfileInput,
  rankMatches,
  mapMatchCard,
  normalizeCourseCode,
  MAX_BIO,
} from '../src/friendMatching.mjs'

// Issue #17 - profile validation + match ranking by shared courses.

test('re-exports the #33 course-code normalizer', () => {
  assert.equal(normalizeCourseCode('cs18000'), 'CS 18000')
})

test('validateProfileInput trims, de-dupes interests, and reads discoverable', () => {
  const { value, error } = validateProfileInput({
    bio: '  Hi there ',
    interests: ['Chess', 'chess', ' Hiking '],
    discoverable: 'true',
  })
  assert.equal(error, undefined)
  assert.equal(value.bio, 'Hi there')
  assert.deepEqual(value.interests, ['Chess', 'Hiking'])
  assert.equal(value.discoverable, true)
})

test('validateProfileInput rejects an over-length bio and too many interests', () => {
  assert.match(validateProfileInput({ bio: 'a'.repeat(MAX_BIO + 1) }).error, /Bio must be/)
  const many = Array.from({ length: 11 }, (_, i) => `i${i}`)
  assert.match(validateProfileInput({ interests: many }).error, /at most/)
})

test('rankMatches keeps overlaps and sorts by shared count desc', () => {
  const mine = new Set(['CS 18000', 'MA 16500', 'ENGL 10600'])
  const candidates = [
    { userId: 'a', courses: ['CS 18000'] },
    { userId: 'b', courses: ['CS 18000', 'MA 16500'] },
    { userId: 'c', courses: ['PHYS 17200'] },
  ]
  const ranked = rankMatches(mine, candidates)
  assert.deepEqual(ranked.map((r) => r.userId), ['b', 'a'])
  assert.equal(ranked[0].sharedCount, 2)
})

test('rankMatches returns empty when the user has no courses', () => {
  assert.deepEqual(rankMatches([], [{ userId: 'a', courses: ['CS 18000'] }]), [])
})

test('mapMatchCard exposes only non-sensitive fields', () => {
  const card = mapMatchCard({ id: 'u1', display_name: 'Alex', email: 'a@purdue.edu', interests: ['Chess'] }, 2)
  assert.deepEqual(card, { userId: 'u1', displayName: 'Alex', interests: ['Chess'], sharedCount: 2 })
  assert.equal(card.email, undefined)
})
