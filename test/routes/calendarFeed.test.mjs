import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createCalendarFeedRouter } from '../../src/routes/calendarFeed.mjs'
import { buildCalendarFeed } from '../../src/icsFeed.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the calendar feed routes as a feature router, booted on a small
// app with a fake session, recording limiters and a recording database. The
// feed itself has no session user (a calendar app sends no cookie), so the
// token in its URL is the only credential: these tests also pin that a
// malformed name never reaches the database and that the token is never
// logged.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com', calendar_feed_token: null }
const TOKEN = '2f1c9e7a-4b6d-4a1e-9c3f-8d2b7e5a1f04'
const PUBLIC_BASE_URL = 'https://api.boilerindy.test'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SIGNED_OUT = { error: { message: 'You must sign in to access this resource.', status: 401 } }

const knownToken = () => ({ data: { id: STUDENT.id }, error: null })
const noRows = () => ({ data: [], error: null })

async function withApp({ user = STUDENT, tables = {} } = {}, run) {
  const supabase = fakeSupabase(tables)
  const limiterHits = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(
    createCalendarFeedRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json(SIGNED_OUT)
        req.currentUser = user
        next()
      },
      publicBaseUrl: PUBLIC_BASE_URL,
      calendarFeedRateLimit: limiter('calendar-feed'),
      userWriteRateLimit: limiter('user-write'),
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path) => {
    const response = await fetch(base + path, { method })
    const text = await response.text()
    const isJson = (response.headers.get('content-type') || '').startsWith('application/json')
    return { status: response.status, headers: response.headers, text, body: isJson && text ? JSON.parse(text) : null }
  }
  try {
    await run({ call, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function assertPlainNotFound(res, label) {
  assert.equal(res.status, 404, label)
  assert.match(res.headers.get('content-type'), /^text\/plain/, label)
  assert.equal(res.text, 'Not found', label)
}

// ── The feed link: /api/me/calendar-feed ────────────────────────────────────

test('both feed link routes answer the 401 envelope signed out, with no query', async () => {
  await withApp({ user: null }, async ({ call, supabase }) => {
    for (const [method, path] of [['GET', '/api/me/calendar-feed'], ['POST', '/api/me/calendar-feed/token']]) {
      const res = await call(method, path)
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.deepEqual(res.body, SIGNED_OUT, `${method} ${path}`)
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('the limiters: user-write ahead of auth on the token route only, calendar-feed on every feed request before the token checks', async () => {
  await withApp({ user: null, tables: { users: () => ({ data: null, error: null }) } }, async ({ call, limiterHits }) => {
    assert.equal((await call('GET', '/api/me/calendar-feed')).status, 401)
    assert.equal((await call('POST', '/api/me/calendar-feed/token')).status, 401)
    for (const file of ['not-a-token.ics', TOKEN, `${TOKEN}.txt`, `${TOKEN}.ics`]) {
      assertPlainNotFound(await call('GET', `/feeds/calendar/${file}`), file)
    }
    assert.deepEqual(limiterHits, [
      'user-write POST /api/me/calendar-feed/token',
      'calendar-feed GET /feeds/calendar/not-a-token.ics',
      `calendar-feed GET /feeds/calendar/${TOKEN}`,
      `calendar-feed GET /feeds/calendar/${TOKEN}.txt`,
      `calendar-feed GET /feeds/calendar/${TOKEN}.ics`,
    ])
  })
})

test('GET /api/me/calendar-feed answers null before a link is made, then the link on the public base URL', async () => {
  await withApp({ user: { ...STUDENT, calendar_feed_token: null } }, async ({ call, supabase, limiterHits }) => {
    const res = await call('GET', '/api/me/calendar-feed')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { feedUrl: null })
    assert.equal(supabase.queries.length, 0, 'the token comes from the session user, not a query')
    assert.deepEqual(limiterHits, [], 'the read has no limiter')
  })
  await withApp({ user: { ...STUDENT, calendar_feed_token: TOKEN } }, async ({ call }) => {
    const res = await call('GET', '/api/me/calendar-feed')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { feedUrl: `${PUBLIC_BASE_URL}/feeds/calendar/${TOKEN}.ics` })
  })
})

test('POST /api/me/calendar-feed/token stores a fresh UUID v4 on the student only and answers its link', async () => {
  const tables = { users: () => ({ data: null, error: null }) }
  await withApp({ user: { ...STUDENT, calendar_feed_token: TOKEN }, tables }, async ({ call, supabase, limiterHits }) => {
    const res = await call('POST', '/api/me/calendar-feed/token')
    assert.equal(res.status, 200)
    const writes = supabase.queriesOf('users')
    assert.equal(writes.length, 1)
    const [{ chain }] = writes
    assert.equal(operation(chain), 'update')
    assert.deepEqual(chain.map((c) => c.method), ['update', 'eq'])
    const [values] = chain[0].args
    assert.deepEqual(Object.keys(values), ['calendar_feed_token'])
    assert.match(values.calendar_feed_token, UUID_V4)
    assert.notEqual(values.calendar_feed_token, TOKEN, 'regenerating replaces the old token')
    assert.ok(hasCall(chain, 'eq', 'id', STUDENT.id))
    assert.deepEqual(res.body, { feedUrl: `${PUBLIC_BASE_URL}/feeds/calendar/${values.calendar_feed_token}.ics` })
    assert.deepEqual(limiterHits, ['user-write POST /api/me/calendar-feed/token'])
  })
})

test('a failed token write answers the 500 envelope and logs the database message, not the new token', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const tables = { users: () => ({ data: null, error: { message: 'column users.calendar_feed_token does not exist' } }) }
  await withApp({ tables }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/me/calendar-feed/token')
    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { error: { message: 'Could not generate a calendar feed link. Please try again.', status: 500 } })
    const [{ chain }] = supabase.queriesOf('users')
    const minted = chain[0].args[0].calendar_feed_token
    assert.equal(log.mock.callCount(), 1)
    assert.deepEqual(log.mock.calls[0].arguments, ['POST /api/me/calendar-feed/token:', 'column users.calendar_feed_token does not exist'])
    assert.ok(!log.mock.calls[0].arguments.join(' ').includes(minted))
  })
})

// ── The feed: /feeds/calendar/:file ─────────────────────────────────────────

test('a name without .ics or a token that is not a UUID v4 answers a plain 404 before any query', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  await withApp({ user: null }, async ({ call, supabase }) => {
    const malformed = [
      TOKEN, // no extension
      `${TOKEN}.txt`,
      `${TOKEN}.ics.txt`,
      'not-a-token.ics',
      '.ics',
      '11111111-1111-1111-8111-111111111111.ics', // a version 1 UUID
      '11111111-1111-4111-c111-111111111111.ics', // a v4 shape with the wrong variant
      `${TOKEN}0.ics`,
      `x${TOKEN}.ics`,
    ]
    for (const file of malformed) {
      assertPlainNotFound(await call('GET', `/feeds/calendar/${file}`), file)
    }
    assert.equal(supabase.queries.length, 0)
  })
  assert.equal(log.mock.callCount(), 0)
})

test('an unknown token, or a lookup that fails, answers the same plain 404 after looking up the token alone', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  let lookup = { data: null, error: null }
  await withApp({ user: null, tables: { users: () => lookup } }, async ({ call, supabase }) => {
    assertPlainNotFound(await call('GET', `/feeds/calendar/${TOKEN}.ics`), 'unknown token')
    lookup = { data: null, error: { message: 'connection reset' } }
    assertPlainNotFound(await call('GET', `/feeds/calendar/${TOKEN}.ics`), 'failed lookup')
    for (const { table, chain } of supabase.queries) {
      assert.equal(table, 'users')
      assert.deepEqual(chain, [
        { method: 'select', args: ['id'] },
        { method: 'eq', args: ['calendar_feed_token', TOKEN] },
        { method: 'maybeSingle', args: [] },
      ])
    }
    assert.equal(supabase.queries.length, 2)
  })
  assert.equal(log.mock.callCount(), 0, 'neither 404 logs anything')
})

test('a known token answers the next six months of calendar items and the open tasks as a private text/calendar feed', async () => {
  const items = [
    { id: 'item-1', title: 'CSCI 36200 Lecture', description: 'Bring a laptop', start_time: '2026-10-05T14:00:00.000Z', end_time: '2026-10-05T15:15:00.000Z', location: 'SL 110' },
    { id: 'item-2', title: null, description: null, start_time: '2026-10-06T18:00:00.000Z', end_time: null, location: null },
  ]
  const tasks = [
    { id: 'task-1', title: 'Problem set 4', due_at: '2026-10-07T03:59:00.000Z' },
    { id: 'task-2', title: '', due_at: '2026-10-08T16:00:00.000Z' },
  ]
  const tables = {
    users: knownToken,
    calendar_items: () => ({ data: items, error: null }),
    user_manual_tasks: () => ({ data: tasks, error: null }),
  }
  await withApp({ user: null, tables }, async ({ call, supabase }) => {
    const before = Date.now()
    const res = await call('GET', `/feeds/calendar/${TOKEN}.ics`)
    const after = Date.now()
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8')
    assert.equal(res.headers.get('content-disposition'), 'inline; filename="boilerindy.ics"')
    assert.equal(res.headers.get('cache-control'), 'private, max-age=900')

    const [user] = supabase.queriesOf('users')
    assert.deepEqual(user.chain, [
      { method: 'select', args: ['id'] },
      { method: 'eq', args: ['calendar_feed_token', TOKEN] },
      { method: 'maybeSingle', args: [] },
    ])

    // The window starts at the request and ends six calendar months later.
    const [itemsQuery] = supabase.queriesOf('calendar_items')
    const now = new Date(itemsQuery.chain.find((c) => c.method === 'gte').args[1])
    assert.ok(now.getTime() >= before && now.getTime() <= after, 'the window starts now')
    const horizon = new Date(now)
    horizon.setMonth(horizon.getMonth() + 6)
    assert.deepEqual(itemsQuery.chain, [
      { method: 'select', args: ['id, title, description, start_time, end_time, location'] },
      { method: 'eq', args: ['user_id', STUDENT.id] },
      { method: 'gte', args: ['start_time', now.toISOString()] },
      { method: 'lte', args: ['start_time', horizon.toISOString()] },
      { method: 'order', args: ['start_time', { ascending: true }] },
    ])
    const [tasksQuery] = supabase.queriesOf('user_manual_tasks')
    assert.deepEqual(tasksQuery.chain, [
      { method: 'select', args: ['id, title, due_at'] },
      { method: 'eq', args: ['user_id', STUDENT.id] },
      { method: 'is', args: ['completed_at', null] },
      { method: 'order', args: ['due_at', { ascending: true }] },
    ])

    // Written out from the rows: the title fallbacks, the empty fields left
    // out, and each task as an all-day event under a manual- UID.
    const expected = buildCalendarFeed({
      now,
      events: [
        { uid: 'item-1', summary: 'CSCI 36200 Lecture', description: 'Bring a laptop', location: 'SL 110', start: new Date(items[0].start_time), end: new Date(items[0].end_time) },
        { uid: 'item-2', summary: 'Untitled', start: new Date(items[1].start_time) },
        { uid: 'manual-task-1', summary: 'Problem set 4', start: new Date(tasks[0].due_at), allDay: true },
        { uid: 'manual-task-2', summary: 'Task', start: new Date(tasks[1].due_at), allDay: true },
      ],
    })
    assert.equal(res.text, expected)
    assert.match(res.text, /\r\nUID:manual-task-1@boilerindy\r\n/)
  })
})

test('.ICS in capitals is accepted, as before the move', async () => {
  const tables = { users: knownToken, calendar_items: noRows, user_manual_tasks: noRows }
  await withApp({ user: null, tables }, async ({ call, supabase }) => {
    const res = await call('GET', `/feeds/calendar/${TOKEN}.ICS`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8')
    assert.ok(hasCall(supabase.queriesOf('users')[0].chain, 'eq', 'calendar_feed_token', TOKEN))
  })
})

test('either list failing answers a plain 500 that is not cached, and the token is never logged', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const failure = () => ({ data: null, error: { message: 'canceling statement due to statement timeout' } })
  for (const failing of ['calendar_items', 'user_manual_tasks']) {
    const tables = { users: knownToken, calendar_items: noRows, user_manual_tasks: noRows, [failing]: failure }
    await withApp({ user: null, tables }, async ({ call }) => {
      const res = await call('GET', `/feeds/calendar/${TOKEN}.ics`)
      assert.equal(res.status, 500, failing)
      assert.match(res.headers.get('content-type'), /^text\/plain/, failing)
      assert.equal(res.text, 'Calendar feed temporarily unavailable', failing)
      assert.equal(res.headers.get('cache-control'), null, failing)
    })
  }
  assert.equal(log.mock.callCount(), 2)
  for (const { arguments: args } of log.mock.calls) {
    assert.deepEqual(args, ['GET /feeds/calendar:', 'canceling statement due to statement timeout'])
  }
  const printed = log.mock.calls.flatMap((c) => c.arguments.map(String)).join('\n')
  assert.ok(!printed.includes(TOKEN), 'the token is not in the log')
})
