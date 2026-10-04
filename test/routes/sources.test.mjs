import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import express from 'express'
import ical from 'node-ical'
import { createSourcesRouter } from '../../src/routes/sources.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the linked calendar source routes and the source re-sync cron
// route as a feature router, booted on a small app with a fake session,
// recording limiters, a recording database that keeps linked_sources rows in
// memory, and fakes of what server.mjs hands in: the onboarding cache, the two
// Sentry warnings and the cron token check. Nothing leaves the machine: fetch
// answers the feed URLs from the ICS fixture below and passes only the test
// app's own http://127.0.0.1 calls through, and dns.lookup answers a TEST-NET
// address, so assertSafeHttpUrl runs for real without a resolver.
//
// The auto-capture start route launches a visible Chromium once it is past
// its guards, so every call to it here is signed out, has automation off, or
// comes from a student with no Purdue link while linking is on.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com', purdue_email: 'student@purdue.edu' }
const OTHER = { id: '22222222-2222-4222-8222-222222222222', email: 'other@example.com', purdue_email: 'other@purdue.edu' }
const UNLINKED = { id: '33333333-3333-4333-8333-333333333333', email: 'unlinked@example.com', purdue_email: null }
const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PURDUE_FEED = 'https://timetable.mypurdue.purdue.edu/Timetabling/export?token=feed-token'
const BRIGHTSPACE_FEED = 'https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=feed-token'
const CRON_SECRET = 'cron-secret-for-tests'
const AUTH = { authorization: `Bearer ${CRON_SECRET}` }
const LINK_FIRST = 'Link your Purdue account before connecting Purdue schedule data.'
const AUTOMATION_OFF = 'Purdue schedule auto-capture is disabled on this server. Paste your UniTime iCalendar URL instead.'
const NOT_FOUND = { error: { message: 'Not found.', status: 404 } }
const SOURCE_NOT_FOUND = { error: { message: 'Source not found.', status: 404 } }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//BoilerIndy tests//EN',
  'BEGIN:VEVENT',
  'UID:hw5-due@purdue.brightspace.com',
  'DTSTART:20261019T035900Z',
  'DTEND:20261019T035900Z',
  'SUMMARY:Homework 5 - ENGR 13300 - Due',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:lab2-due@purdue.brightspace.com',
  'DTSTART:20261023T035900Z',
  'DTEND:20261023T035900Z',
  'SUMMARY:Lab 2 - ENGR 13300 - Due',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

const icsFeed = () => new Response(FEED, { status: 200, headers: { 'content-type': 'text/calendar' } })
const feedStatus = (status) => () => new Response('', { status })

// isCalendarAutomationEnabled() reads PURDUE_CALENDAR_AUTOMATION per request:
// off unless a test turns it on, and put back afterwards.
const automationEnv = process.env.PURDUE_CALENDAR_AUTOMATION
delete process.env.PURDUE_CALENDAR_AUTOMATION
after(() => {
  if (automationEnv === undefined) delete process.env.PURDUE_CALENDAR_AUTOMATION
  else process.env.PURDUE_CALENDAR_AUTOMATION = automationEnv
})

async function withAutomationOn(run) {
  process.env.PURDUE_CALENDAR_AUTOMATION = '1'
  try {
    await run()
  } finally {
    delete process.env.PURDUE_CALENDAR_AUTOMATION
  }
}

function sourceRow(overrides = {}) {
  return {
    id: SOURCE_ID,
    user_id: STUDENT.id,
    source_type: 'brightspace_ical',
    label: 'Brightspace Calendar',
    source_url: BRIGHTSPACE_FEED,
    status: 'ready',
    last_synced_at: '2026-10-01T12:00:00.000Z',
    last_error: null,
    created_at: '2026-09-01T12:00:00.000Z',
    updated_at: '2026-10-01T12:00:00.000Z',
    ...overrides,
  }
}

// linked_sources as a small in-memory table, so a dropped filter changes what
// a test reads back: a select answers the rows every eq and in filter on the
// chain matches (single() wants exactly one, as PostgREST does), an insert
// stores its row, an update patches the matches and a delete removes them.
function linkedSourcesTable(rows) {
  const matches = (chain) => (row) =>
    chain.every(({ method, args }) => {
      if (method === 'eq') return row[args[0]] === args[1]
      if (method === 'in') return args[1].includes(row[args[0]])
      return true
    })
  return (chain) => {
    const op = operation(chain)
    if (op === 'insert') {
      const row = { ...chain.find((c) => c.method === 'insert').args[0] }
      rows.push(row)
      return { data: { ...row }, error: null }
    }
    const hits = rows.filter(matches(chain))
    if (op === 'update') {
      const patch = chain.find((c) => c.method === 'update').args[0]
      for (const row of hits) Object.assign(row, patch)
      return { data: null, error: null }
    }
    if (op === 'delete') {
      for (const row of hits) rows.splice(rows.indexOf(row), 1)
      return { data: null, error: null }
    }
    if (hasCall(chain, 'single')) {
      return hits.length === 1
        ? { data: { ...hits[0] }, error: null }
        : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
    }
    return { data: hits.map((row) => ({ ...row })), error: null }
  }
}

async function withApp(
  { user = STUDENT, isProduction = false, purdueLinkingEnabled = true, cronSecret = CRON_SECRET, rows = [], tables = {}, feed } = {},
  run,
) {
  const supabase = fakeSupabase({
    linked_sources: linkedSourcesTable(rows),
    calendar_items: () => ({ data: null, error: null }),
    ...tables,
  })
  const limiterHits = []
  const invalidated = []
  const feedWarnings = []
  const cronWarnings = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(
    createSourcesRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      isProduction,
      purdueLinkingEnabled,
      // server.mjs's onboarding cache: records each invalidation and how many
      // queries had run by then, so a test can pin when it happened.
      onboardingSummaryCache: { invalidate: (userId) => invalidated.push({ userId, afterQueries: supabase.queries.length }) },
      warnFeedTransient: (sourceId, error) => feedWarnings.push({ sourceId, error }),
      sourceSyncRateLimit: limiter('source-sync'),
      userWriteRateLimit: limiter('user-write'),
      PUSH_CRON_SECRET: cronSecret,
      pushCronSecretMatches: (header) => Boolean(cronSecret) && header === `Bearer ${cronSecret}`,
      warnCronTransient: (route, error) => cronWarnings.push({ route, error }),
    }),
  )
  // Stands in for apiNotFound: where the re-sync route falls through to.
  app.use((_req, res) => res.status(404).json(NOT_FOUND))

  // The feed hosts and their DNS, restored when the test is done.
  const feedUrls = []
  const lookups = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init)
    feedUrls.push(String(url))
    if (!feed) throw new Error(`unexpected fetch of ${url}`)
    return feed(String(url), feedUrls.length)
  }
  const lookup = mock.method(dns, 'lookup', async (hostname) => {
    lookups.push(hostname)
    return [{ address: '192.0.2.10', family: 4 }]
  })

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  try {
    await run({ call, supabase, rows, limiterHits, invalidated, feedWarnings, cronWarnings, feedUrls, lookups })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    globalThis.fetch = realFetch
    lookup.mock.restore()
  }
}

// ── Auth, ids and limiters ──────────────────────────────────────────────────

test('every session route needs a signed-in student; only the creates, the sync and the delete spend a limiter, ahead of auth', async () => {
  await withApp({ user: null }, async ({ call, supabase, limiterHits, feedUrls }) => {
    const routes = [
      ['GET', '/api/me/sources'],
      ['GET', `/api/debug/source/${SOURCE_ID}`],
      ['POST', '/api/purdue/calendar-link/start'],
      ['GET', '/api/purdue/calendar-link/status'],
      ['POST', '/api/purdue/calendar-link/cancel'],
      ['POST', '/api/sources/purdue/schedule'],
      ['POST', '/api/sources/brightspace/schedule'],
      ['POST', `/api/sync/${SOURCE_ID}`],
      ['DELETE', `/api/sources/${SOURCE_ID}`],
    ]
    for (const [method, path] of routes) {
      const res = await call(method, path, method === 'GET' ? undefined : {})
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.deepEqual(res.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(feedUrls, [])
    assert.deepEqual(limiterHits, [
      'source-sync POST /api/sources/purdue/schedule',
      'source-sync POST /api/sources/brightspace/schedule',
      `source-sync POST /api/sync/${SOURCE_ID}`,
      `user-write DELETE /api/sources/${SOURCE_ID}`,
    ])
  })
})

test('a malformed source id answers 404 before auth and before any query', async () => {
  await withApp({ user: null }, async ({ call, supabase, limiterHits }) => {
    for (const [method, path] of [
      ['GET', '/api/debug/source/not-a-uuid'],
      ['POST', '/api/sync/not-a-uuid'],
      ['DELETE', '/api/sources/not-a-uuid'],
    ]) {
      const res = await call(method, path, method === 'GET' ? undefined : {})
      assert.equal(res.status, 404, `${method} ${path}`)
      assert.deepEqual(res.body, NOT_FOUND)
    }
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(limiterHits, ['source-sync POST /api/sync/not-a-uuid', 'user-write DELETE /api/sources/not-a-uuid'])
  })
})

// ── GET /api/me/sources ─────────────────────────────────────────────────────

test("GET /api/me/sources lists only the student's sources, newest first, and an empty list on a failed read", async () => {
  const rows = [sourceRow(), sourceRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: OTHER.id })]
  await withApp({ rows }, async ({ call, supabase, limiterHits }) => {
    const res = await call('GET', '/api/me/sources')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      sources: [
        {
          id: SOURCE_ID,
          sourceType: 'brightspace_ical',
          label: 'Brightspace Calendar',
          sourceUrl: BRIGHTSPACE_FEED,
          status: 'ready',
          lastSyncedAt: '2026-10-01T12:00:00.000Z',
          lastError: null,
          createdAt: '2026-09-01T12:00:00.000Z',
          updatedAt: '2026-10-01T12:00:00.000Z',
        },
      ],
    })
    const [list] = supabase.queriesOf('linked_sources')
    assert.ok(hasCall(list.chain, 'select', 'id, source_type, label, source_url, status, last_synced_at, last_error, created_at, updated_at'))
    assert.ok(hasCall(list.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(list.chain, 'order', 'created_at', { ascending: false }))
    assert.deepEqual(limiterHits, [])
  })
  const failing = { linked_sources: () => ({ data: null, error: { message: 'permission denied for table linked_sources' } }) }
  await withApp({ tables: failing }, async ({ call }) => {
    const res = await call('GET', '/api/me/sources')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { sources: [] })
  })
})

// ── requirePurdueLinked and the Purdue auto-capture routes ─────────────────

test('with linking on, a student with no Purdue link cannot add a Purdue schedule or use auto-capture; with linking off they pass', async () => {
  await withApp({ user: UNLINKED }, async ({ call, supabase, feedUrls }) => {
    const res = await call('POST', '/api/sources/purdue/schedule', { icsUrl: PURDUE_FEED })
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: { message: LINK_FIRST, status: 400 } })
    await withAutomationOn(async () => {
      for (const [method, path] of [
        ['POST', '/api/purdue/calendar-link/start'],
        ['GET', '/api/purdue/calendar-link/status'],
        ['POST', '/api/purdue/calendar-link/cancel'],
      ]) {
        const linkRes = await call(method, path, method === 'GET' ? undefined : {})
        assert.equal(linkRes.status, 400, `${method} ${path}`)
        assert.deepEqual(linkRes.body, { error: { message: LINK_FIRST, status: 400 } })
      }
    })
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(feedUrls, [])
  })

  await withApp({ user: UNLINKED, purdueLinkingEnabled: false, feed: icsFeed }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/sources/purdue/schedule', { icsUrl: PURDUE_FEED })
    assert.equal(res.status, 201)
    const [insert] = supabase.queriesOf('linked_sources')
    assert.equal(insert.chain.find((c) => c.method === 'insert').args[0].user_id, UNLINKED.id)
    await withAutomationOn(async () => {
      const status = await call('GET', '/api/purdue/calendar-link/status')
      assert.equal(status.status, 200)
      assert.deepEqual(status.body, { job: null })
    })
  })
})

test('auto-capture is hidden in production and refused unless PURDUE_CALENDAR_AUTOMATION is on', async () => {
  const routes = [
    ['POST', '/api/purdue/calendar-link/start'],
    ['GET', '/api/purdue/calendar-link/status'],
    ['POST', '/api/purdue/calendar-link/cancel'],
  ]
  // Production answers 404 whether or not automation is switched on.
  await withApp({ user: UNLINKED, isProduction: true }, async ({ call }) => {
    for (const automation of [false, true]) {
      const check = async () => {
        for (const [method, path] of routes) {
          const res = await call(method, path, method === 'GET' ? undefined : {})
          assert.equal(res.status, 404, `${method} ${path} (automation ${automation ? 'on' : 'off'})`)
          assert.deepEqual(res.body, NOT_FOUND)
        }
      }
      if (automation) await withAutomationOn(check)
      else await check()
    }
  })
  // Development with automation off: 409 before the Purdue link is checked.
  await withApp({ user: UNLINKED }, async ({ call }) => {
    for (const [method, path] of routes) {
      const res = await call(method, path, method === 'GET' ? undefined : {})
      assert.equal(res.status, 409, `${method} ${path}`)
      assert.deepEqual(res.body, { error: { message: AUTOMATION_OFF, status: 409 } })
    }
  })
  // Automation on: a linked student reaches the job store (no job yet). The
  // start route is left alone here, since it would launch Chromium.
  await withAutomationOn(async () => {
    await withApp({ user: STUDENT }, async ({ call }) => {
      const status = await call('GET', '/api/purdue/calendar-link/status')
      assert.equal(status.status, 200)
      assert.deepEqual(status.body, { job: null })
      const cancel = await call('POST', '/api/purdue/calendar-link/cancel', {})
      assert.equal(cancel.status, 200)
      assert.deepEqual(cancel.body, { job: null })
    })
  })
})

// ── Creating a source ───────────────────────────────────────────────────────

test('the create routes check the URL length and scheme before anything else', async () => {
  await withApp({}, async ({ call, supabase, feedUrls, lookups }) => {
    const cases = [
      ['/api/sources/purdue/schedule', {}, 'Please provide a valid calendar URL.'],
      ['/api/sources/purdue/schedule', { icsUrl: '  https:/  ' }, 'Please provide a valid calendar URL.'],
      ['/api/sources/purdue/schedule', { icsUrl: 'ftp://timetable.mypurdue.purdue.edu/feed.ics' }, 'Calendar URL must start with http:// or https://'],
      ['/api/sources/brightspace/schedule', {}, 'Please provide a calendar URL.'],
      ['/api/sources/brightspace/schedule', { icsUrl: 42 }, 'Please provide a calendar URL.'],
      ['/api/sources/brightspace/schedule', { icsUrl: 'ftp://purdue.brightspace.com/feed.ics' }, 'Calendar URL must start with http:// or https://'],
    ]
    for (const [path, body, message] of cases) {
      const res = await call('POST', path, body)
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`)
      assert.deepEqual(res.body, { error: { message, status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(feedUrls, [])
    assert.deepEqual(lookups, [])
  })
})

test("a feed on another provider's host is refused by the host allowlist before any lookup, insert or fetch", async () => {
  await withApp({ feed: icsFeed }, async ({ call, supabase, feedUrls, lookups }) => {
    for (const [path, icsUrl] of [
      ['/api/sources/brightspace/schedule', 'https://example.com/feed.ics'],
      ['/api/sources/brightspace/schedule', 'https://brightspace.com.example.com/feed.ics'],
      ['/api/sources/purdue/schedule', BRIGHTSPACE_FEED],
    ]) {
      const res = await call('POST', path, { icsUrl })
      assert.equal(res.status, 400, `${path} ${icsUrl}`)
      assert.deepEqual(res.body, { error: { message: 'That calendar provider is not allowed.', status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(lookups, [])
    assert.deepEqual(feedUrls, [])
  })
})

test('POST /api/sources/purdue/schedule stores a pending source for the student, syncs it and answers 201', async () => {
  await withApp({ feed: icsFeed }, async ({ call, supabase, rows, limiterHits, invalidated, feedUrls, lookups }) => {
    const res = await call('POST', '/api/sources/purdue/schedule', { icsUrl: `  ${PURDUE_FEED}  ` })
    assert.equal(res.status, 201)

    const insert = supabase.queriesOf('linked_sources').find((q) => operation(q.chain) === 'insert')
    const row = insert.chain.find((c) => c.method === 'insert').args[0]
    assert.match(row.id, UUID_RE)
    assert.ok(!Number.isNaN(Date.parse(row.created_at)), 'created_at is an ISO timestamp')
    assert.deepEqual(row, {
      id: row.id,
      user_id: STUDENT.id,
      source_type: 'purdue_schedule_ical',
      label: 'Schedule',
      source_url: PURDUE_FEED,
      status: 'pending',
      created_at: row.created_at,
      updated_at: row.created_at,
    })
    assert.ok(hasCall(insert.chain, 'select'))
    assert.ok(hasCall(insert.chain, 'single'))

    // The feed was checked and fetched once, and its two classes upserted.
    assert.deepEqual(feedUrls, [PURDUE_FEED])
    assert.deepEqual(lookups, ['timetable.mypurdue.purdue.edu', 'timetable.mypurdue.purdue.edu'])
    const [upsert, sweep] = supabase.queriesOf('calendar_items')
    const [items, options] = upsert.chain.find((c) => c.method === 'upsert').args
    assert.deepEqual(options, { onConflict: 'source_id,external_uid' })
    assert.deepEqual(
      items.map((item) => [item.user_id, item.source_id, item.category, item.title]),
      [
        [STUDENT.id, row.id, 'class', 'Homework 5 - ENGR 13300'],
        [STUDENT.id, row.id, 'class', 'Lab 2 - ENGR 13300'],
      ],
    )
    assert.equal(operation(sweep.chain), 'delete')
    assert.ok(hasCall(sweep.chain, 'eq', 'source_id', row.id))

    // The cache is dropped when the source is added and again after the sync.
    assert.deepEqual(invalidated.map((i) => i.userId), [STUDENT.id, STUDENT.id])

    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'ready')
    assert.deepEqual(res.body.source, rows[0])
    assert.deepEqual({ ...res.body.sync, syncedAt: undefined }, { syncedAt: undefined, itemCount: 2, skippedCount: 0, timezone: 'Etc/UTC' })
    assert.ok(!Number.isNaN(Date.parse(res.body.sync.syncedAt)))
    const reread = supabase.queriesOf('linked_sources').at(-1)
    assert.ok(hasCall(reread.chain, 'eq', 'id', row.id))
    assert.ok(hasCall(reread.chain, 'eq', 'user_id', STUDENT.id))
    assert.deepEqual(limiterHits, ['source-sync POST /api/sources/purdue/schedule'])
  })
})

test('POST /api/sources/brightspace/schedule needs no Purdue link and labels the source Brightspace Calendar', async () => {
  await withApp({ user: UNLINKED, feed: icsFeed }, async ({ call, supabase, rows, invalidated, feedUrls }) => {
    const res = await call('POST', '/api/sources/brightspace/schedule', { icsUrl: BRIGHTSPACE_FEED })
    assert.equal(res.status, 201)
    const insert = supabase.queriesOf('linked_sources').find((q) => operation(q.chain) === 'insert')
    const row = insert.chain.find((c) => c.method === 'insert').args[0]
    assert.equal(row.user_id, UNLINKED.id)
    assert.equal(row.source_type, 'brightspace_ical')
    assert.equal(row.label, 'Brightspace Calendar')
    assert.equal(row.status, 'pending')
    assert.deepEqual(feedUrls, [BRIGHTSPACE_FEED])
    const [upsert] = supabase.queriesOf('calendar_items')
    const [items] = upsert.chain.find((c) => c.method === 'upsert').args
    assert.deepEqual(items.map((item) => [item.category, item.title]), [
      ['assignment', 'Homework 5 - ENGR 13300'],
      ['lab', 'Lab 2 - ENGR 13300'],
    ])
    assert.deepEqual(invalidated.map((i) => i.userId), [UNLINKED.id, UNLINKED.id])
    assert.equal(res.body.source.id, rows[0].id)
    assert.equal(res.body.sync.itemCount, 2)
  })
})

// ── POST /api/sync/:sourceId ────────────────────────────────────────────────

test("another student's source is not found for a sync, a delete or the debug view", async () => {
  await withApp({ user: OTHER, rows: [sourceRow()], feed: icsFeed }, async ({ call, supabase, rows, invalidated, feedUrls }) => {
    for (const [method, path] of [
      ['POST', `/api/sync/${SOURCE_ID}`],
      ['DELETE', `/api/sources/${SOURCE_ID}`],
      ['GET', `/api/debug/source/${SOURCE_ID}`],
    ]) {
      const res = await call(method, path, method === 'GET' ? undefined : {})
      assert.equal(res.status, 404, `${method} ${path}`)
      assert.deepEqual(res.body, SOURCE_NOT_FOUND)
    }
    // Each was one read scoped to the id and the caller, and nothing else.
    const reads = supabase.queriesOf('linked_sources')
    assert.equal(supabase.queries.length, 3)
    for (const read of reads) {
      assert.equal(operation(read.chain), 'select')
      assert.ok(hasCall(read.chain, 'eq', 'id', SOURCE_ID))
      assert.ok(hasCall(read.chain, 'eq', 'user_id', OTHER.id))
      assert.ok(hasCall(read.chain, 'single'))
    }
    assert.deepEqual(feedUrls, [])
    assert.deepEqual(invalidated, [])
    assert.deepEqual(rows, [sourceRow()])
  })
})

test('POST /api/sync/:sourceId re-imports the feed once and answers the source and the sync', async () => {
  await withApp({ rows: [sourceRow({ status: 'error', last_error: 'Could not fetch the calendar feed.' })], feed: icsFeed }, async ({ call, rows, limiterHits, invalidated, feedUrls, feedWarnings }) => {
    const res = await call('POST', `/api/sync/${SOURCE_ID}`, {})
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.body), ['source', 'sync'])
    assert.equal(res.body.sync.itemCount, 2)
    assert.equal(res.body.sync.skippedCount, 0)
    assert.equal(res.body.source.status, 'ready')
    assert.equal(res.body.source.last_error, null)
    assert.equal(rows[0].status, 'ready')
    assert.deepEqual(feedUrls, [BRIGHTSPACE_FEED])
    assert.deepEqual(invalidated.map((i) => i.userId), [STUDENT.id])
    assert.deepEqual(feedWarnings, [])
    assert.deepEqual(limiterHits, [`source-sync POST /api/sync/${SOURCE_ID}`])
  })
})

test('a sync that skips items it cannot date adds the warning', async () => {
  // A real feed cannot get here today: expandRecurringEvents drops an event
  // it cannot date before planSync counts it. A recurrence rule whose
  // occurrence comes back as no date at all still reaches the count, so the
  // parser stand-in hands one over next to a good event.
  const parsed = {
    'hw5-due@purdue.brightspace.com': {
      type: 'VEVENT',
      uid: 'hw5-due@purdue.brightspace.com',
      summary: 'Homework 5 - ENGR 13300 - Due',
      start: new Date('2026-10-19T03:59:00.000Z'),
      end: new Date('2026-10-19T03:59:00.000Z'),
    },
    'office-hours@purdue.brightspace.com': {
      type: 'VEVENT',
      uid: 'office-hours@purdue.brightspace.com',
      summary: 'Office hours',
      start: new Date('2026-10-01T14:00:00.000Z'),
      end: new Date('2026-10-01T15:00:00.000Z'),
      rrule: { between: () => [new Date(Number.NaN)] },
    },
  }
  const parse = mock.method(ical.async, 'parseICS', async () => parsed)
  try {
    await withApp({ rows: [sourceRow()], feed: icsFeed }, async ({ call }) => {
      const res = await call('POST', `/api/sync/${SOURCE_ID}`, {})
      assert.equal(res.status, 200)
      assert.equal(res.body.sync.itemCount, 1)
      assert.equal(res.body.sync.skippedCount, 1)
      assert.equal(res.body.warning, '1 items had invalid dates and were skipped.')
      assert.equal(res.body.source.last_error, 'Synced with 1 items skipped due to invalid dates')
    })
  } finally {
    parse.mock.restore()
  }
})

test("a feed host's 503 goes to warnFeedTransient and marks the source error; a 404 is not a warning", async () => {
  await withApp({ rows: [sourceRow()], feed: feedStatus(503) }, async ({ call, rows, feedUrls, feedWarnings, invalidated }) => {
    const res = await call('POST', `/api/sync/${SOURCE_ID}`, {})
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: { message: 'Could not fetch the calendar feed.', status: 400 } })
    // The Sync button does not retry: one fetch.
    assert.deepEqual(feedUrls, [BRIGHTSPACE_FEED])
    assert.equal(feedWarnings.length, 1)
    assert.equal(feedWarnings[0].sourceId, SOURCE_ID)
    assert.equal(feedWarnings[0].error.status, 503)
    assert.equal(rows[0].status, 'error')
    assert.equal(rows[0].last_error, 'Could not fetch the calendar feed.')
    assert.deepEqual(invalidated, [])
  })
  await withApp({ rows: [sourceRow()], feed: feedStatus(404) }, async ({ call, rows, feedWarnings }) => {
    const res = await call('POST', `/api/sync/${SOURCE_ID}`, {})
    const message = 'Calendar not found. The URL may be incorrect or the calendar may have been deleted.'
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: { message, status: 400 } })
    assert.deepEqual(feedWarnings, [])
    assert.equal(rows[0].status, 'error')
    assert.equal(rows[0].last_error, message)
  })
})

// ── DELETE /api/sources/:sourceId ───────────────────────────────────────────

test("DELETE /api/sources/:sourceId removes the source's items, then the source, then drops the cached counts", async () => {
  const rows = [sourceRow(), sourceRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })]
  await withApp({ rows }, async ({ call, supabase, limiterHits, invalidated }) => {
    const res = await call('DELETE', `/api/sources/${SOURCE_ID}`, {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, message: 'Source and all associated items deleted.' })
    const [read, items, source] = supabase.queries
    assert.deepEqual([read.table, operation(read.chain)], ['linked_sources', 'select'])
    assert.ok(hasCall(read.chain, 'eq', 'user_id', STUDENT.id))
    assert.deepEqual([items.table, operation(items.chain)], ['calendar_items', 'delete'])
    assert.ok(hasCall(items.chain, 'eq', 'source_id', SOURCE_ID))
    assert.deepEqual([source.table, operation(source.chain)], ['linked_sources', 'delete'])
    assert.ok(hasCall(source.chain, 'eq', 'id', SOURCE_ID))
    assert.equal(supabase.queries.length, 3)
    assert.deepEqual(invalidated, [{ userId: STUDENT.id, afterQueries: 3 }])
    assert.deepEqual(rows.map((row) => row.id), ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
    assert.deepEqual(limiterHits, [`user-write DELETE /api/sources/${SOURCE_ID}`])
  })
})

// ── GET /api/debug/source/:sourceId ─────────────────────────────────────────

test('the debug view answers 404 in production before any query, and a sample of the parsed feed in development', async () => {
  await withApp({ isProduction: true, rows: [sourceRow()], feed: icsFeed }, async ({ call, supabase, feedUrls }) => {
    const res = await call('GET', `/api/debug/source/${SOURCE_ID}`)
    assert.equal(res.status, 404)
    assert.deepEqual(res.body, NOT_FOUND)
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(feedUrls, [])
  })
  await withApp({ rows: [sourceRow()], feed: icsFeed }, async ({ call, supabase }) => {
    const res = await call('GET', `/api/debug/source/${SOURCE_ID}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.sourceId, SOURCE_ID)
    assert.equal(res.body.sourceType, 'brightspace_ical')
    assert.equal(res.body.detectedTimezone, 'Etc/UTC')
    assert.equal(res.body.rawEventCount, 2)
    assert.equal(res.body.expandedEventCount, 2)
    assert.equal(res.body.sampleRawEvents[0].summary, 'Homework 5 - ENGR 13300 - Due')
    assert.equal(res.body.sampleExpandedEvents[0].start, '2026-10-19T03:59:00.000Z')
    assert.equal(supabase.queries.length, 1, 'one read, nothing written')
  })
})

// ── POST /api/internal/sources/resync ───────────────────────────────────────

test('the re-sync falls through to the 404 without a cron token and refuses a wrong one', async () => {
  await withApp({ cronSecret: '' }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/internal/sources/resync', undefined, { authorization: 'Bearer anything' })
    assert.equal(res.status, 404)
    assert.deepEqual(res.body, NOT_FOUND)
    assert.equal(supabase.queries.length, 0)
  })
  await withApp({}, async ({ call, supabase, limiterHits }) => {
    for (const headers of [{ authorization: 'Bearer wrong' }, {}]) {
      const res = await call('POST', '/api/internal/sources/resync', undefined, headers)
      assert.equal(res.status, 401)
      assert.deepEqual(res.body, { error: { message: 'Invalid cron secret.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(limiterHits, [])
  })
})

test('with the token, a due source is re-synced and a feed that fails once is retried', async () => {
  const rows = [sourceRow({ last_synced_at: null })]
  const feed = (url, attempt) => (attempt === 1 ? new Response('', { status: 503 }) : icsFeed())
  await withApp({ user: null, rows, feed }, async ({ call, supabase, invalidated, feedUrls, feedWarnings, cronWarnings, limiterHits }) => {
    const res = await call('POST', '/api/internal/sources/resync', undefined, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(
      { ...res.body, durationMs: undefined },
      { ok: true, scanned: 1, truncated: false, due: 1, synced: 1, failed: 0, deferred: 0, items: 2, failures: [], durationMs: undefined },
    )
    assert.deepEqual(feedUrls, [BRIGHTSPACE_FEED, BRIGHTSPACE_FEED])
    assert.deepEqual(feedWarnings, [])
    assert.deepEqual(cronWarnings, [])
    const [listing] = supabase.queriesOf('linked_sources')
    assert.ok(hasCall(listing.chain, 'in', 'status', ['ready', 'error', 'pending']))
    assert.equal(rows[0].status, 'ready')
    assert.ok(rows[0].last_synced_at)
    assert.deepEqual(invalidated.map((i) => i.userId), [STUDENT.id])
    assert.deepEqual(limiterHits, [])
  })
})

test('a re-sync already in flight answers 409, and the next one runs once it is done', async () => {
  const table = linkedSourcesTable([])
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let reached
  const firstListing = new Promise((resolve) => {
    reached = resolve
  })
  let listings = 0
  const tables = {
    linked_sources: async (chain) => {
      if (hasCall(chain, 'in', 'status')) {
        listings += 1
        if (listings === 1) {
          reached()
          await gate
        }
      }
      return table(chain)
    },
  }
  await withApp({ tables }, async ({ call }) => {
    const first = call('POST', '/api/internal/sources/resync', undefined, AUTH)
    try {
      await firstListing
      const second = await call('POST', '/api/internal/sources/resync', undefined, AUTH)
      assert.equal(second.status, 409)
      assert.deepEqual(second.body, { ok: false, error: 'resync_in_progress' })
    } finally {
      release()
    }
    assert.equal((await first).status, 200)
    const third = await call('POST', '/api/internal/sources/resync', undefined, AUTH)
    assert.equal(third.status, 200)
    assert.equal(third.body.due, 0)
    assert.equal(listings, 2)
  })
})

test('a listing that fails transiently twice answers 503 through warnCronTransient; any other failure is a 500', async () => {
  const gateway = () => ({ data: null, error: { message: 'Gateway Timeout' }, status: 504 })
  await withApp({ tables: { linked_sources: gateway } }, async ({ call, supabase, cronWarnings }) => {
    const res = await call('POST', '/api/internal/sources/resync', undefined, AUTH)
    assert.equal(res.status, 503)
    assert.deepEqual(res.body, { ok: false, error: 'Resync run skipped: upstream unavailable, the next tick will retry.' })
    assert.equal(supabase.queriesOf('linked_sources').length, 2, 'retried once')
    assert.equal(cronWarnings.length, 1)
    assert.equal(cronWarnings[0].route, 'POST /api/internal/sources/resync')
    assert.equal(cronWarnings[0].error.status, 504)
  })
  const broken = () => ({ data: null, error: { code: '42501', message: 'permission denied for table linked_sources' }, status: 401 })
  await withApp({ tables: { linked_sources: broken } }, async ({ call, supabase, cronWarnings }) => {
    const res = await call('POST', '/api/internal/sources/resync', undefined, AUTH)
    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { ok: false, error: 'Resync run failed.' })
    assert.equal(supabase.queriesOf('linked_sources').length, 1)
    assert.deepEqual(cronWarnings, [])
  })
})
