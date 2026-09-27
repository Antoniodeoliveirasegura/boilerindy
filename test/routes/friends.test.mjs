import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createFriendsRouter } from '../../src/routes/friends.mjs'
import { BOARD_PROFANITY_USER_MESSAGE } from '../../src/boardProfanity.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the Friend Matching routes as a feature router, booted on a
// small app with a fake session, recording limiters, a recording database and
// a fake of the class-items reader server.mjs injects.

const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'me@purdue.edu' }
const ANA = '22222222-2222-4222-8222-222222222222'
const BO = '33333333-3333-4333-8333-333333333333'
const CY = '44444444-4444-4444-8444-444444444444'
const DEE = '55555555-5555-4555-8555-555555555555'

const CLASS_ITEMS = [{ title: 'CS 18000 Lecture' }, { title: 'MA 16500 Recitation' }, { title: 'ENGL 10600' }]

async function withApp({ user = ME, handlers = {}, classItems = CLASS_ITEMS } = {}, run) {
  const supabase = fakeSupabase({
    user_profiles: () => ({ data: null, error: null }),
    friend_match_courses: () => ({ data: [], error: null }),
    connections: () => ({ data: [], error: null }),
    users: () => ({ data: [], error: null }),
    ...handlers,
  })
  const limiterHits = []
  const classItemCalls = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(
    createFriendsRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      getClassItemsForUser: async (userId, options) => {
        classItemCalls.push({ userId, options })
        return { items: classItems }
      },
      boardWriteRateLimit: limiter('boardWriteRateLimit'),
      userWriteRateLimit: limiter('userWriteRateLimit'),
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  try {
    await run({ call, supabase, limiterHits, classItemCalls })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const ROUTES = [
  ['GET', '/api/me/profile-card'],
  ['PUT', '/api/me/profile-card'],
  ['GET', '/api/me/matches'],
  ['POST', '/api/connections'],
  ['PATCH', `/api/connections/${ANA}`],
  ['GET', '/api/me/connections'],
]

test('every route sits behind requireAuth', async () => {
  await withApp({ user: null }, async ({ call, supabase, classItemCalls }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path, method === 'GET' ? undefined : { bio: 'hi', addresseeId: ANA, action: 'accept' })
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.equal(classItemCalls.length, 0)
  })
})

test('the writes pass their limiters: board-write for the profile and a request, user-write for accept or decline', async () => {
  const handlers = {
    connections: (chain) => (operation(chain) === 'update' ? { data: [{ requester_id: ANA }], error: null } : { data: [], error: null }),
  }
  await withApp({ handlers }, async ({ call, limiterHits }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path, method === 'GET' ? undefined : { bio: 'hi', addresseeId: ANA, action: 'accept' })
      assert.ok(answer.status < 300, `${method} ${path} answered ${answer.status}`)
    }
    assert.deepEqual(limiterHits, [
      'boardWriteRateLimit PUT /api/me/profile-card',
      'boardWriteRateLimit POST /api/connections',
      `userWriteRateLimit PATCH /api/connections/${ANA}`,
    ])
  })
})

test('the profile card answers defaults without a row, and the stored card otherwise', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/profile-card')
    assert.deepEqual(answer.body, { bio: '', interests: [], discoverable: false })
    assert.ok(hasCall(supabase.queries[0].chain, 'eq', 'user_id', ME.id))
  })
  const handlers = { user_profiles: () => ({ data: { bio: 'CS junior', interests: ['chess'], discoverable: true }, error: null }) }
  await withApp({ handlers }, async ({ call }) => {
    const answer = await call('GET', '/api/me/profile-card')
    assert.deepEqual(answer.body, { bio: 'CS junior', interests: ['chess'], discoverable: true })
  })
})

test('the profile write validates, runs the profanity check, upserts and snapshots courses only when discoverable', async () => {
  await withApp({}, async ({ call, supabase, classItemCalls }) => {
    const long = await call('PUT', '/api/me/profile-card', { bio: 'x'.repeat(301) })
    assert.equal(long.status, 400)
    assert.deepEqual(long.body, { error: { message: 'Bio must be 300 characters or fewer', status: 400 } })
    const many = await call('PUT', '/api/me/profile-card', { interests: Array.from({ length: 11 }, (_, i) => `topic ${i}`) })
    assert.deepEqual(many.body, { error: { message: 'Add at most 10 interests', status: 400 } })
    const profane = await call('PUT', '/api/me/profile-card', { bio: 'hi', interests: ['bastard jokes'] })
    assert.deepEqual(profane.body, { error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const saved = await call('PUT', '/api/me/profile-card', { bio: ' CS junior ', interests: 'chess, Chess, climbing', discoverable: true })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body, { ok: true, bio: 'CS junior', interests: ['chess', 'climbing'], discoverable: true })
    const [upsert] = supabase.queriesOf('user_profiles')
    const call0 = upsert.chain.find((c) => c.method === 'upsert')
    assert.deepEqual(call0.args[1], { onConflict: 'user_id' })
    assert.equal(call0.args[0].user_id, ME.id)
    assert.ok(!Number.isNaN(Date.parse(call0.args[0].updated_at)))
    const [clear, snapshot] = supabase.queriesOf('friend_match_courses')
    assert.equal(operation(clear.chain), 'delete')
    assert.ok(hasCall(clear.chain, 'eq', 'user_id', ME.id))
    assert.ok(
      hasCall(snapshot.chain, 'insert', [
        { user_id: ME.id, course_code: 'CS 18000' },
        { user_id: ME.id, course_code: 'ENGL 10600' },
        { user_id: ME.id, course_code: 'MA 16500' },
      ]),
    )
    assert.deepEqual(classItemCalls, [{ userId: ME.id, options: { term: 'auto', limit: 200 } }])
  })
  await withApp({}, async ({ call, supabase, classItemCalls }) => {
    const hidden = await call('PUT', '/api/me/profile-card', { bio: 'lurking', discoverable: false })
    assert.equal(hidden.body.discoverable, false)
    assert.deepEqual(supabase.queriesOf('friend_match_courses').map((q) => operation(q.chain)), ['delete'])
    assert.equal(classItemCalls.length, 0)
  })
})

test('matches: nothing unless I am discoverable, and never my own row', async () => {
  await withApp({ handlers: { user_profiles: () => ({ data: { discoverable: false }, error: null }) } }, async ({ call, supabase, classItemCalls }) => {
    const answer = await call('GET', '/api/me/matches')
    assert.deepEqual(answer.body, { matches: [], discoverable: false })
    assert.equal(supabase.queriesOf('friend_match_courses').length, 0)
    assert.equal(classItemCalls.length, 0)
  })
  const handlers = {
    user_profiles: () => ({ data: { discoverable: true }, error: null }),
    friend_match_courses: () => ({ data: [{ user_id: ME.id, course_code: 'CS 18000' }], error: null }),
  }
  await withApp({ handlers }, async ({ call }) => {
    const answer = await call('GET', '/api/me/matches')
    assert.deepEqual(answer.body, { matches: [], discoverable: true })
  })
})

test('matches come only from discoverable users without a connection, ranked by overlap, with the pre-acceptance card only', async () => {
  const handlers = {
    user_profiles: (chain) =>
      hasCall(chain, 'maybeSingle')
        ? { data: { discoverable: true }, error: null }
        : {
            data: [
              { user_id: ANA, interests: ['chess'], discoverable: true },
              { user_id: BO, interests: ['climbing'], discoverable: true },
              { user_id: DEE, interests: ['secret'], discoverable: false },
            ],
            error: null,
          },
    friend_match_courses: () => ({
      data: [
        { user_id: ANA, course_code: 'CS 18000' },
        { user_id: BO, course_code: 'CS 18000' },
        { user_id: BO, course_code: 'MA 16500' },
        { user_id: CY, course_code: 'MA 16500' },
        { user_id: DEE, course_code: 'ENGL 10600' },
        { user_id: ME.id, course_code: 'CS 18000' },
      ],
      error: null,
    }),
    // CY already has a connection with me (any direction or status).
    connections: () => ({ data: [{ requester_id: CY, addressee_id: ME.id }], error: null }),
    users: () => ({
      data: [
        { id: ANA, display_name: 'Ana', email: 'ana@purdue.edu' },
        { id: BO, display_name: null, email: 'bo@purdue.edu' },
        { id: DEE, display_name: 'Dee', email: 'dee@purdue.edu' },
      ],
      error: null,
    }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/matches')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.discoverable, true)
    assert.deepEqual(answer.body.matches, [
      { userId: BO, displayName: 'Student', interests: ['climbing'], sharedCount: 2, sharedCourses: ['CS 18000', 'MA 16500'] },
      { userId: ANA, displayName: 'Ana', interests: ['chess'], sharedCount: 1, sharedCourses: ['CS 18000'] },
    ])
    // Before acceptance a card never carries an email or anything else.
    for (const card of answer.body.matches) {
      assert.deepEqual(Object.keys(card).sort(), ['displayName', 'interests', 'sharedCount', 'sharedCourses', 'userId'])
    }
    const [courses] = supabase.queriesOf('friend_match_courses')
    assert.ok(hasCall(courses.chain, 'in', 'course_code', ['CS 18000', 'ENGL 10600', 'MA 16500']))
    const [conns] = supabase.queriesOf('connections')
    assert.ok(hasCall(conns.chain, 'or', `requester_id.eq.${ME.id},addressee_id.eq.${ME.id}`))
    const [users] = supabase.queriesOf('users')
    assert.ok(hasCall(users.chain, 'select', 'id, display_name'), 'the email column is never read for matches')
  })
})

test('a connection request goes through sendConnectionRequest', async () => {
  let discoverable = false
  const handlers = {
    user_profiles: () => ({ data: { discoverable }, error: null }),
    connections: () => ({ data: null, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const bad = await call('POST', '/api/connections', { addresseeId: 'nope' })
    assert.equal(bad.status, 400)
    assert.deepEqual(bad.body, { error: { message: 'A valid recipient is required.', status: 400 } })
    const self = await call('POST', '/api/connections', { addresseeId: ME.id.toUpperCase() })
    assert.equal(self.status, 400)

    const quiet = await call('POST', '/api/connections', { addresseeId: ANA })
    assert.deepEqual(quiet.body, { ok: true, status: 'pending' })
    assert.equal(supabase.queriesOf('connections').length, 0, 'a non-discoverable addressee gets no row, and the answer looks the same')

    discoverable = true
    const sent = await call('POST', '/api/connections', { addresseeId: ANA })
    assert.deepEqual(sent.body, { ok: true, status: 'pending' })
    const upsert = supabase.queriesOf('connections').find((q) => operation(q.chain) === 'upsert')
    const [values, options] = upsert.chain.find((c) => c.method === 'upsert').args
    assert.equal(values.requester_id, ME.id)
    assert.equal(values.addressee_id, ANA)
    assert.equal(values.status, 'pending')
    assert.ok(!Number.isNaN(Date.parse(values.created_at)), 'the clock the router passes stamps the request')
    assert.deepEqual(options, { onConflict: 'requester_id,addressee_id' })
  })
})

test('accept or decline is only honoured by the addressee of a pending request from that requester', async () => {
  let rows = [{ requester_id: ANA }]
  const handlers = { connections: () => ({ data: rows, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const bad = await call('PATCH', `/api/connections/${ANA}`, { action: 'block' })
    assert.equal(bad.status, 400)
    assert.deepEqual(bad.body, { error: { message: 'Action must be accept or decline.', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const accepted = await call('PATCH', `/api/connections/${ANA}`, { action: 'accept' })
    assert.deepEqual(accepted.body, { ok: true, status: 'accepted' })
    const [{ chain }] = supabase.queriesOf('connections')
    assert.ok(hasCall(chain, 'update', { status: 'accepted' }))
    assert.ok(hasCall(chain, 'eq', 'requester_id', ANA))
    assert.ok(hasCall(chain, 'eq', 'addressee_id', ME.id), 'only the addressee can answer')
    assert.ok(hasCall(chain, 'eq', 'status', 'pending'))

    const declined = await call('PATCH', `/api/connections/${ANA}`, { action: 'decline' })
    assert.deepEqual(declined.body, { ok: true, status: 'declined' })

    rows = []
    const none = await call('PATCH', `/api/connections/${ANA}`, { action: 'accept' })
    assert.equal(none.status, 404)
    assert.deepEqual(none.body, { error: { message: 'No pending request from that user.', status: 404 } })
  })
})

test('my connections: accepted ones carry the email, incoming requests do not, outgoing ones are not listed', async () => {
  const handlers = {
    connections: () => ({
      data: [
        { requester_id: ME.id, addressee_id: ANA, status: 'accepted' },
        { requester_id: BO, addressee_id: ME.id, status: 'pending' },
        { requester_id: ME.id, addressee_id: CY, status: 'pending' },
      ],
      error: null,
    }),
    users: () => ({ data: [{ id: ANA, display_name: 'Ana', email: 'ana@purdue.edu' }, { id: BO, display_name: 'Bo', email: 'bo@purdue.edu' }], error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/connections')
    assert.deepEqual(answer.body, {
      accepted: [{ userId: ANA, displayName: 'Ana', email: 'ana@purdue.edu' }],
      incoming: [{ userId: BO, displayName: 'Bo' }],
    })
    const [users] = supabase.queriesOf('users')
    assert.ok(hasCall(users.chain, 'in', 'id', [ANA, BO, CY]))
  })
  await withApp({}, async ({ call, supabase }) => {
    assert.deepEqual((await call('GET', '/api/me/connections')).body, { accepted: [], incoming: [] })
    assert.equal(supabase.queriesOf('users').length, 0, 'no user lookup without connections')
  })
})

test('database failures answer friends_schema_missing for a missing table and the friends fallback otherwise', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const noTable = { user_profiles: () => ({ data: null, error: { code: '42P01', message: 'relation "public.user_profiles" does not exist' } }) }
  await withApp({ handlers: noTable }, async ({ call }) => {
    const answer = await call('GET', '/api/me/profile-card')
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, { error: { message: 'Friend matching is not set up yet. Please try again later.', code: 'friends_schema_missing', status: 503 } })
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-friend-matching\.sql/)
  const broken = { connections: () => ({ data: null, error: { code: '23514', message: 'check constraint' } }) }
  await withApp({ handlers: broken }, async ({ call }) => {
    const answer = await call('GET', '/api/me/connections')
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not load matches. Please try again.', status: 500 } })
  })
})

test('a malformed :requesterId answers the 404 envelope before any query', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('PATCH', '/api/connections/not-a-uuid', { action: 'accept' })
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, { error: { message: 'Not found.', status: 404 } })
    assert.equal(supabase.queries.length, 0)
  })
})
