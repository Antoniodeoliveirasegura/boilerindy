import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateProfileInput,
  rankMatches,
  mapMatchCard,
  canReceiveFriendRequest,
  sendConnectionRequest,
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

// Issue #203 - requests only reach users who opted in to matching.

test('canReceiveFriendRequest is false for an unknown user (no profile row)', () => {
  assert.equal(canReceiveFriendRequest(null), false)
  assert.equal(canReceiveFriendRequest(undefined), false)
  assert.equal(canReceiveFriendRequest({}), false)
})

test('canReceiveFriendRequest is false when discoverable is off', () => {
  assert.equal(canReceiveFriendRequest({ discoverable: false }), false)
})

test('canReceiveFriendRequest is true when discoverable is on', () => {
  assert.equal(canReceiveFriendRequest({ discoverable: true }), true)
})

const ME = '11111111-1111-4111-8111-111111111111'
const THEM = '2f6b7a1e-9c4d-4e8f-8a1b-3c5d7e9f0a2b'
const NOW = '2026-09-16T12:00:00.000Z'
const PENDING = { status: 200, body: { ok: true, status: 'pending' } }

// Fake Supabase covering the two chains the route uses:
// from(t).select(c).eq(...).eq(...).maybeSingle() and from(t).upsert(row, opts).
// Every call is recorded so a test can prove what was (not) written.
function fakeSupabase({ profile = null, profileError = null, prior = null, upsertError = null } = {}) {
  const calls = []
  const supabase = {
    from(table) {
      let entry
      const query = {
        select(cols) {
          entry = { op: 'select', table, cols, filters: {} }
          calls.push(entry)
          return query
        },
        eq(col, val) {
          entry.filters[col] = val
          return query
        },
        maybeSingle() {
          if (table === 'user_profiles') return Promise.resolve({ data: profile, error: profileError })
          return Promise.resolve({ data: prior, error: null })
        },
        upsert(row, opts) {
          calls.push({ op: 'upsert', table, row, opts })
          return Promise.resolve({ error: upsertError })
        },
      }
      return query
    },
  }
  return { supabase, calls, upserts: () => calls.filter((c) => c.op === 'upsert') }
}

const send = (supabase, raw) => sendConnectionRequest(supabase, ME, raw, { nowIso: () => NOW })

test('sendConnectionRequest does not persist a request to an unknown user', async () => {
  const { supabase, calls, upserts } = fakeSupabase({ profile: null })
  assert.deepEqual(await send(supabase, THEM), PENDING)
  assert.deepEqual(calls[0], { op: 'select', table: 'user_profiles', cols: 'discoverable', filters: { user_id: THEM } })
  assert.equal(upserts().length, 0)
})

test('sendConnectionRequest does not persist a request to a non-discoverable user', async () => {
  const { supabase, calls, upserts } = fakeSupabase({ profile: { discoverable: false } })
  assert.deepEqual(await send(supabase, THEM), PENDING, 'same answer as a real request')
  assert.equal(upserts().length, 0)
  assert.equal(calls.length, 1, 'stops before reading connections')
})

test('sendConnectionRequest upserts one pending row for a discoverable user', async () => {
  const { supabase, upserts } = fakeSupabase({ profile: { discoverable: true } })
  assert.deepEqual(await send(supabase, ` ${THEM.toUpperCase()} `), PENDING)
  assert.deepEqual(upserts(), [
    {
      op: 'upsert',
      table: 'connections',
      row: { requester_id: ME, addressee_id: THEM, status: 'pending', created_at: NOW },
      opts: { onConflict: 'requester_id,addressee_id' },
    },
  ])
})

test('sendConnectionRequest stays silent when the addressee declined before', async () => {
  const { supabase, upserts } = fakeSupabase({ profile: { discoverable: true }, prior: { status: 'declined' } })
  assert.deepEqual(await send(supabase, THEM), PENDING)
  assert.equal(upserts().length, 0)
})

test('sendConnectionRequest answers 400 for a malformed or self id without touching the DB', async () => {
  for (const raw of [undefined, '', 'abc', `${THEM}' OR '1'='1`, { id: THEM }, ME, ME.toUpperCase()]) {
    const { supabase, calls } = fakeSupabase({ profile: { discoverable: true } })
    assert.deepEqual(await send(supabase, raw), {
      status: 400,
      body: { error: { message: 'A valid recipient is required.', status: 400 } },
    })
    assert.equal(calls.length, 0)
  }
})

test('sendConnectionRequest throws DB errors instead of faking a pending answer', async () => {
  const missing = { code: 'PGRST205', message: 'user_profiles not found' }
  const lookup = fakeSupabase({ profileError: missing })
  await assert.rejects(send(lookup.supabase, THEM), (e) => e === missing)
  assert.equal(lookup.upserts().length, 0)

  const failed = { code: '23503', message: 'fk violation' }
  const write = fakeSupabase({ profile: { discoverable: true }, upsertError: failed })
  await assert.rejects(send(write.supabase, THEM), (e) => e === failed)
})
