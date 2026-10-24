import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildClubDirectory, degradedClubDirectory } from '../src/boilerlinkClubs.mjs'
import { FOLLOWABLE_SOURCES, clubForOrganizationKey, followedClubs, readFollowedKeys } from '../src/clubFollows.mjs'
import { ENGAGE_SOURCE_KEYS } from '../src/sharedEvents.mjs'
import { fakeSupabase } from './routes/fakeSupabase.mjs'

// Issue #16: following a club. The directory lookups the follow routes use,
// over the 13 real BoilerLink rows in test/fixtures, and the read of one
// student's follows that marks their clubs' events on Events and Free Food.

const DIRECTORY = buildClubDirectory(
  JSON.parse(readFileSync(new URL('./fixtures/boilerlink-organizations.json', import.meta.url), 'utf8')).value,
)

test('only BoilerLink clubs can be followed: it is the one Engage source with a directory', () => {
  assert.deepEqual(FOLLOWABLE_SOURCES, ['boilerlink'])
  assert.ok(FOLLOWABLE_SOURCES.every((key) => ENGAGE_SOURCE_KEYS.includes(key)))
})

test('clubForOrganizationKey finds a directory club by its BoilerLink key, and nothing else', () => {
  assert.equal(clubForOrganizationKey(DIRECTORY, 'boilerlink:401442')?.name, 'Taekwondo Club of Purdue Indianapolis')
  assert.equal(clubForOrganizationKey(DIRECTORY, 'boilerlink:404807')?.slug, DIRECTORY.clubs.find((club) => club.id === '404807').slug)
  for (const key of ['boilerlink:398688', 'thespot:401442', '401442', 'boilerlink:0401442', null, undefined, 401442]) {
    assert.equal(clubForOrganizationKey(DIRECTORY, key), null, String(key))
  }
  assert.equal(clubForOrganizationKey(null, 'boilerlink:401442'), null)
  assert.equal(clubForOrganizationKey(degradedClubDirectory('timeout'), 'boilerlink:401442'), null)
  // A refreshed directory is a new object, so a new index.
  const refreshed = buildClubDirectory([])
  assert.equal(clubForOrganizationKey(refreshed, 'boilerlink:401442'), null)
  assert.ok(clubForOrganizationKey(DIRECTORY, 'boilerlink:401442'))
})

test('followedClubs lists the followed clubs the directory has, in its name order, each with its key', () => {
  const clubs = followedClubs(DIRECTORY, ['boilerlink:420522', 'boilerlink:398688', 'boilerlink:401442', 'thespot:135000', 'junk', 'boilerlink:401442'])
  assert.deepEqual(clubs.map((club) => [club.organizationKey, club.name]), [
    ['boilerlink:401442', 'Taekwondo Club of Purdue Indianapolis'],
    ['boilerlink:420522', 'USB Indy'],
  ])
  const usb = DIRECTORY.clubs.find((club) => club.id === '420522')
  assert.deepEqual(clubs[1], { ...usb, organizationKey: 'boilerlink:420522' })
  assert.notEqual(clubs[1], usb, 'the directory club itself is never changed')
  assert.equal('organizationKey' in usb, false)
  assert.deepEqual(followedClubs(DIRECTORY, []), [])
  assert.deepEqual(followedClubs(null, ['boilerlink:401442']), [])
})

test("readFollowedKeys reads one student's keys as a set", async () => {
  const supabase = fakeSupabase({
    club_follows: () => ({ data: [{ organization_key: 'boilerlink:401442' }, { organization_key: 'boilerlink:420522' }, { organization_key: null }], error: null }),
  })
  assert.deepEqual([...(await readFollowedKeys(supabase, 'u1'))], ['boilerlink:401442', 'boilerlink:420522'])
  const [read] = supabase.queriesOf('club_follows')
  assert.deepEqual(read.chain, [
    { method: 'select', args: ['organization_key'] },
    { method: 'eq', args: ['user_id', 'u1'] },
  ])
})

test('readFollowedKeys never throws: a missing table logs the file once, other failures every time, and both answer null', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const missing = fakeSupabase({
    club_follows: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.club_follows' in the schema cache (unit test)" } }),
  })
  // Null, not an empty set: "not known" must not read as "follows nothing".
  assert.equal(await readFollowedKeys(missing, 'u1'), null)
  assert.equal(await readFollowedKeys(missing, 'u1'), null)
  assert.equal(logged.mock.callCount(), 1)
  assert.match(logged.mock.calls[0].arguments[0], /^\[club_follows\] schema missing: run db\/supabase-club-follows\.sql/)

  const slow = fakeSupabase({ club_follows: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) })
  assert.equal(await readFollowedKeys(slow, 'u1'), null)
  assert.deepEqual(logged.mock.calls[1].arguments, ['%s:', 'club_follows read', '57014', 'canceling statement due to statement timeout'])

  // The fake throws for a table it has no handler for, as a network error would.
  assert.equal(await readFollowedKeys(fakeSupabase({}), 'u1'), null)
  assert.equal(logged.mock.callCount(), 3)

  // A student who follows nothing is an empty set.
  assert.equal((await readFollowedKeys(fakeSupabase({ club_follows: () => ({ data: [], error: null }) }), 'u1'))?.size, 0)
})
