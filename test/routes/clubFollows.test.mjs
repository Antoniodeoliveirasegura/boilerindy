import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { buildClubDirectory, degradedClubDirectory } from '../../src/boilerlinkClubs.mjs'
import { createClubFollowsRouter } from '../../src/routes/clubFollows.mjs'
import { CLUB_FOLLOWS_CAP_MESSAGE, MAX_CLUB_FOLLOWS } from '../../src/userWriteCaps.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #16: following a club. The follow routes boot here on a small app with
// a fake session, a recording limiter, a recording database and a club
// directory built from the 13 real BoilerLink rows in test/fixtures, the way
// server.mjs mounts them with the real ones.

const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'me@purdue.edu' }
const TAEKWONDO = 'boilerlink:401442' // Taekwondo Club of Purdue Indianapolis
const CHESS = 'boilerlink:404807' // Chess Club Purdue Indianapolis
const GONE = 'boilerlink:398688' // a club the directory no longer lists
const DIRECTORY = buildClubDirectory(
  JSON.parse(readFileSync(new URL('../fixtures/boilerlink-organizations.json', import.meta.url), 'utf8')).value,
)
const SIGN_IN = { error: { message: 'You must sign in to access this resource.', status: 401 } }
const SCHEMA_MISSING = {
  error: { message: 'Following clubs is not set up yet. Please try again later.', code: 'club_follows_schema_missing', status: 503 },
}
const BAD_KEY = { error: { message: 'That is not a club the app knows.', code: 'club_follows_bad_key', status: 400 } }
const tableMissing = () => ({ code: 'PGRST205', message: "Could not find the table 'public.club_follows' in the schema cache (route test)" })

const ROUTES = [
  ['GET', '/api/me/club-follows'],
  ['PUT', `/api/me/club-follows/${TAEKWONDO}`],
  ['DELETE', `/api/me/club-follows/${TAEKWONDO}`],
]

// club_follows as the routes use it: the student's keys, the upsert and the delete.
function followsTable({ keys = [], error = null, writeError = null } = {}) {
  return (chain) => {
    if (error) return { data: null, error }
    const op = operation(chain)
    if (op === 'upsert' || op === 'delete') return { data: null, error: writeError }
    return { data: keys.map((key) => ({ organization_key: key })), error: null }
  }
}

async function withApp({ user = ME, table = followsTable(), directory = DIRECTORY } = {}, run) {
  const supabase = fakeSupabase({ club_follows: table })
  const limiterHits = []
  let directoryReads = 0
  const app = express()
  app.use(express.json())
  app.use(
    createClubFollowsRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json(SIGN_IN)
        req.currentUser = user
        next()
      },
      userWriteRateLimit: (req, _res, next) => {
        limiterHits.push(`userWriteRateLimit ${req.method} ${req.path}`)
        next()
      },
      clubDirectoryCache: {
        get: async () => {
          directoryReads += 1
          return { directory, stale: false }
        },
      },
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path) => {
    const response = await fetch(base + path, { method })
    return { status: response.status, body: await response.json() }
  }
  try {
    await run({ call, supabase, limiterHits, directoryReads: () => directoryReads })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const writes = (supabase) => supabase.queriesOf('club_follows').filter((q) => ['upsert', 'delete'].includes(operation(q.chain)))

test('every route sits behind requireAuth, and a signed-out call touches nothing', async () => {
  await withApp({ user: null }, async ({ call, supabase, directoryReads }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path)
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, SIGN_IN)
    }
    assert.equal(supabase.queries.length, 0)
    assert.equal(directoryReads(), 0)
  })
})

test('the two writes pass user-write under the server.mjs name, the read does not', async () => {
  await withApp({}, async ({ call, limiterHits }) => {
    for (const [method, path] of ROUTES) await call(method, path)
    assert.deepEqual(limiterHits, [`userWriteRateLimit PUT /api/me/club-follows/${TAEKWONDO}`, `userWriteRateLimit DELETE /api/me/club-follows/${TAEKWONDO}`])
  })
})

test('GET answers my follows oldest first, and the followed clubs the directory lists in its name order', async () => {
  await withApp({ table: followsTable({ keys: [TAEKWONDO, GONE, CHESS] }) }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/club-follows')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.follows, [TAEKWONDO, GONE, CHESS])
    // Chess before Taekwondo, as the directory sorts them; the club that left
    // BoilerLink stays in follows, so it can still be unfollowed.
    assert.deepEqual(answer.body.clubs.map((club) => [club.organizationKey, club.name]), [
      [CHESS, 'Chess Club Purdue Indianapolis'],
      [TAEKWONDO, 'Taekwondo Club of Purdue Indianapolis'],
    ])
    const taekwondo = DIRECTORY.clubs.find((club) => club.id === '401442')
    assert.deepEqual(answer.body.clubs[1], { ...taekwondo, organizationKey: TAEKWONDO })
    const [read] = supabase.queriesOf('club_follows')
    assert.deepEqual(read.chain, [
      { method: 'select', args: ['organization_key'] },
      { method: 'eq', args: ['user_id', ME.id] },
      { method: 'order', args: ['created_at', { ascending: true }] },
      { method: 'order', args: ['organization_key', { ascending: true }] },
    ])
  })
})

test('GET with no follows answers empty lists; with BoilerLink down since boot, the follows without clubs', async () => {
  await withApp({}, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/me/club-follows')).body, { follows: [], clubs: [] })
  })
  await withApp({ table: followsTable({ keys: [TAEKWONDO] }), directory: degradedClubDirectory('timeout') }, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/me/club-follows')).body, { follows: [TAEKWONDO], clubs: [] })
  })
})

test('PUT follows a club the directory lists, idempotently, keeping the first follow', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('PUT', `/api/me/club-follows/${TAEKWONDO}`)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true, organizationKey: TAEKWONDO, following: true })
    const [upsert] = writes(supabase)
    assert.ok(
      hasCall(upsert.chain, 'upsert', { user_id: ME.id, organization_key: TAEKWONDO }, { onConflict: 'user_id,organization_key', ignoreDuplicates: true }),
    )
    // The key read is the student's own.
    const [read] = supabase.queriesOf('club_follows')
    assert.ok(hasCall(read.chain, 'eq', 'user_id', ME.id))
  })
  // Again with it already followed: the same answer.
  await withApp({ table: followsTable({ keys: [TAEKWONDO] }) }, async ({ call }) => {
    const answer = await call('PUT', `/api/me/club-follows/${TAEKWONDO}`)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true, organizationKey: TAEKWONDO, following: true })
  })
  // A client that encodes the colon gets the same club.
  await withApp({}, async ({ call }) => {
    const answer = await call('PUT', '/api/me/club-follows/boilerlink%3A401442')
    assert.deepEqual(answer.body, { ok: true, organizationKey: TAEKWONDO, following: true })
  })
})

test(`PUT stops at ${MAX_CLUB_FOLLOWS} clubs with club_follows_limit, while a repeat at the cap still answers 200`, async () => {
  assert.equal(MAX_CLUB_FOLLOWS, 100)
  const others = Array.from({ length: MAX_CLUB_FOLLOWS }, (_, i) => `boilerlink:${1000 + i}`)
  await withApp({ table: followsTable({ keys: others }) }, async ({ call, supabase }) => {
    const answer = await call('PUT', `/api/me/club-follows/${TAEKWONDO}`)
    assert.equal(answer.status, 409)
    assert.deepEqual(answer.body, { error: { message: CLUB_FOLLOWS_CAP_MESSAGE, code: 'club_follows_limit', status: 409 } })
    assert.equal(writes(supabase).length, 0)
  })
  await withApp({ table: followsTable({ keys: [...others.slice(1), TAEKWONDO] }) }, async ({ call }) => {
    assert.equal((await call('PUT', `/api/me/club-follows/${TAEKWONDO}`)).status, 200)
  })
  await withApp({ table: followsTable({ keys: others.slice(1) }) }, async ({ call }) => {
    assert.equal((await call('PUT', `/api/me/club-follows/${TAEKWONDO}`)).status, 200, 'the hundredth club')
  })
})

test('PUT and DELETE refuse a key that is not `boilerlink:<Id>` or `thespot:<Id>` before any read', async () => {
  await withApp({}, async ({ call, supabase, directoryReads }) => {
    for (const key of ['401442', 'boilerlink', 'boilerlink:', 'boilerlink:abc', 'boilerlink:0401442', 'BoilerLink:401442', 'purdue_events:1', 'boilerlink:1234567890123', 'boilerlink%3A401442%20']) {
      for (const method of ['PUT', 'DELETE']) {
        const answer = await call(method, `/api/me/club-follows/${key}`)
        assert.equal(answer.status, 400, `${method} ${key}`)
        assert.deepEqual(answer.body, BAD_KEY)
      }
    }
    assert.equal(supabase.queries.length, 0)
    assert.equal(directoryReads(), 0)
  })
})

test('PUT answers 404 club_follows_unknown_club for a club the directory does not list, TheSpot included', async () => {
  await withApp({}, async ({ call, supabase }) => {
    for (const key of [GONE, 'thespot:135000']) {
      const answer = await call('PUT', `/api/me/club-follows/${key}`)
      assert.equal(answer.status, 404, key)
      assert.deepEqual(answer.body, { error: { message: 'That club is not in the club directory.', code: 'club_follows_unknown_club', status: 404 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('PUT answers 503 club_follows_directory_unavailable while BoilerLink has not answered since boot', async () => {
  await withApp({ directory: degradedClubDirectory('timeout') }, async ({ call, supabase }) => {
    const answer = await call('PUT', `/api/me/club-follows/${TAEKWONDO}`)
    assert.equal(answer.status, 503)
    assert.equal(answer.body.error.code, 'club_follows_directory_unavailable')
    assert.doesNotMatch(answer.body.error.code, /_schema_missing$/, 'not the "coming soon" state')
    assert.equal(supabase.queries.length, 0)
  })
})

test('DELETE unfollows by student and key, idempotently, and needs no directory', async () => {
  await withApp({ table: followsTable({ keys: [GONE] }), directory: degradedClubDirectory('timeout') }, async ({ call, supabase, directoryReads }) => {
    for (const key of [GONE, TAEKWONDO]) {
      const answer = await call('DELETE', `/api/me/club-follows/${key}`)
      assert.equal(answer.status, 200)
      assert.deepEqual(answer.body, { ok: true, organizationKey: key, following: false })
    }
    const [first] = writes(supabase)
    assert.equal(operation(first.chain), 'delete')
    assert.ok(hasCall(first.chain, 'eq', 'user_id', ME.id))
    assert.ok(hasCall(first.chain, 'eq', 'organization_key', GONE))
    assert.equal(directoryReads(), 0)
  })
})

test('a missing club_follows table answers 503 club_follows_schema_missing on every route', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  await withApp({ table: followsTable({ error: tableMissing() }) }, async ({ call }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path)
      assert.equal(answer.status, 503, `${method} ${path}`)
      assert.deepEqual(answer.body, SCHEMA_MISSING)
    }
  })
  // The file to run is logged once, never sent.
  assert.equal(logged.mock.callCount(), 1)
  assert.match(logged.mock.calls[0].arguments[0], /^\[club_follows\] schema missing: run db\/supabase-club-follows\.sql/)
})

test('any other database failure answers 500 with a fixed message and no code', async (t) => {
  t.mock.method(console, 'error', () => {})
  const timeout = { code: '57014', message: 'canceling statement due to statement timeout' }
  const fallback = { error: { message: 'Could not update the clubs you follow. Please try again.', status: 500 } }
  await withApp({ table: followsTable({ error: timeout }) }, async ({ call }) => {
    for (const [method, path] of ROUTES) assert.deepEqual((await call(method, path)).body, fallback, `${method} ${path}`)
  })
  await withApp({ table: followsTable({ writeError: timeout }) }, async ({ call }) => {
    assert.deepEqual(await call('PUT', `/api/me/club-follows/${TAEKWONDO}`), { status: 500, body: fallback })
    assert.deepEqual(await call('DELETE', `/api/me/club-follows/${TAEKWONDO}`), { status: 500, body: fallback })
  })
})
