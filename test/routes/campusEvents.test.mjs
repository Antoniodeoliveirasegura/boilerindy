import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { createCampusEventsPublicRouter, createCampusEventsRouter } from '../../src/routes/campusEvents.mjs'
import { createStaleCache } from '../../src/upstreamFetch.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #30: the shared campus events ingest cron route, booted on a small app
// with a recording database and fakes of what server.mjs hands in (the cron
// token check, the transient-failure warning, the club directory cache).
// Nothing leaves the machine: the ingest's fetch is a fake answering each
// source's host with the 2026-10-17 fixtures (test/sharedEvents.test.mjs), and
// only the test's own calls to the app go over the loopback.

const CRON_SECRET = 'cron-secret-for-tests'
const AUTH = { authorization: `Bearer ${CRON_SECRET}` }
const NOT_FOUND = { error: { message: 'Not found.', status: 404 } }
const NOW = new Date('2026-10-17T12:00:00.000Z')

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const BODIES = {
  'events.purdue.edu': fixture('campus-events-localist.json'),
  'events.iu.edu': fixture('campus-events-livewhale.json'),
  'boilerlink.purdue.edu': fixture('campus-events-boilerlink.json'),
  'thespot.indianapolis.iu.edu': fixture('campus-events-thespot.json'),
  // Fetched at 17:30 in Indianapolis on 2026-10-24 (WRSP_NOW).
  'whiteriverstatepark.org': fixture('campus-events-wrsp.json'),
}
const WRSP_NOW = new Date('2026-10-24T21:30:00.000Z')

function campusEventsTable({ upsert = () => ({ error: null }) } = {}) {
  return (chain) => {
    const op = operation(chain)
    if (op === 'upsert') return upsert(chain)
    if (op === 'delete') return { count: 0, error: null }
    throw new Error(`unexpected ${op} on campus_events`)
  }
}

async function withApp(
  { cronSecret = CRON_SECRET, engageEnabled = false, downtownEnabled = false, classify = null, table = campusEventsTable(), directory = { ok: true, clubs: [] }, gate, now = NOW } = {},
  run,
) {
  const supabase = fakeSupabase({ campus_events: table })
  const fetched = []
  const fetchedUrls = []
  const cronWarnings = []
  let directoryReads = 0
  const fetchImpl = async (url) => {
    const { hostname } = new URL(String(url))
    fetched.push(hostname)
    fetchedUrls.push(String(url))
    if (gate) await gate(hostname)
    if (!BODIES[hostname]) throw new Error(`unexpected fetch of ${url}`)
    return new Response(BODIES[hostname], { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const app = express()
  app.use(express.json())
  app.use(
    createCampusEventsRouter({
      supabase,
      PUSH_CRON_SECRET: cronSecret,
      pushCronSecretMatches: (header) => Boolean(cronSecret) && header === `Bearer ${cronSecret}`,
      warnCronTransient: (route, error) => cronWarnings.push({ route, error }),
      clubDirectoryCache: {
        get: async () => {
          directoryReads += 1
          return { directory, stale: false }
        },
      },
      engageEnabled,
      downtownEnabled,
      classify,
      ingestOptions: { fetchImpl, now, sleep: async () => {}, log: { log() {}, error() {}, warn() {} } },
    }),
  )
  // Stands in for apiNotFound: where the route falls through to.
  app.use((_req, res) => res.status(404).json(NOT_FOUND))

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, { body, headers = AUTH } = {}) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  try {
    await run({ call, supabase, fetched, fetchedUrls, cronWarnings, directoryReads: () => directoryReads })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const PATH = '/api/internal/campus-events/ingest'

test('the ingest falls through to the 404 without a cron token and refuses a wrong one', async (t) => {
  t.mock.method(console, 'log', () => {})
  await withApp({ cronSecret: '' }, async ({ call, supabase, fetched }) => {
    const res = await call(PATH, { headers: { authorization: 'Bearer anything' } })
    assert.equal(res.status, 404)
    assert.deepEqual(res.body, NOT_FOUND)
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(fetched, [])
  })
  await withApp({}, async ({ call, supabase, fetched }) => {
    for (const headers of [{ authorization: 'Bearer wrong' }, {}]) {
      const res = await call(PATH, { headers })
      assert.equal(res.status, 401)
      assert.deepEqual(res.body, { error: { message: 'Invalid cron secret.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(fetched, [])
  })
})

test('a dry run, asked for in the query or the body, answers the rows and writes nothing', async (t) => {
  t.mock.method(console, 'log', () => {})
  await withApp({}, async ({ call, supabase, fetched, directoryReads }) => {
    for (const request of [{ path: `${PATH}?dryRun=1` }, { path: PATH, body: { dryRun: true } }]) {
      const res = await call(request.path, { body: request.body })
      assert.equal(res.status, 200)
      assert.equal(res.body.ok, true)
      assert.equal(res.body.dryRun, true)
      assert.equal(res.body.rows.length, 17)
      assert.deepEqual(res.body.sources.map((s) => [s.key, s.enabled]), [
        ['purdue_events', true], ['iu_events', true], ['boilerlink', false], ['thespot', false],
      ])
    }
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual([...new Set(fetched)], ['events.purdue.edu', 'events.iu.edu'])
    assert.equal(directoryReads(), 0, 'the club directory is read only with Engage on')
  })
})

test('a run upserts, sweeps and answers its summary; the cron body {} is a run, not a dry run', async (t) => {
  const lines = []
  t.mock.method(console, 'log', (line) => lines.push(line))
  await withApp({}, async ({ call, supabase }) => {
    const res = await call(PATH, { body: {} })
    assert.equal(res.status, 200)
    assert.equal(res.body.dryRun, false)
    assert.equal(res.body.upserted, 17)
    assert.equal(res.body.rows, undefined)
    const ops = supabase.queriesOf('campus_events').map((q) => operation(q.chain))
    assert.deepEqual(ops, ['upsert', 'delete', 'delete'])
  })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[campus-events\] run: purdue_events=9 iu_events=8, 17 rows, 17 upserted in \d+ ms$/)
})

test('with Engage on, the club directory is read and BoilerLink and TheSpot are fetched', async (t) => {
  t.mock.method(console, 'log', () => {})
  const directory = { ok: true, clubs: [{ id: '398688', indianapolis: true }] }
  await withApp({ engageEnabled: true, directory }, async ({ call, fetched, directoryReads }) => {
    const res = await call(`${PATH}?dryRun=true`)
    assert.equal(res.status, 200)
    assert.deepEqual([...new Set(fetched)], ['events.purdue.edu', 'events.iu.edu', 'boilerlink.purdue.edu', 'thespot.indianapolis.iu.edu'])
    assert.equal(directoryReads(), 1)
    assert.equal(res.body.collapsed.length, 1)
    // Club Volleyball's away game is kept on the directory's word.
    assert.ok(res.body.rows.some((row) => row.dedupe_key === 'boilerlink:12891899'))
  })
  // A degraded directory falls back to the organization names.
  await withApp({ engageEnabled: true, directory: { ok: false, clubs: [] } }, async ({ call }) => {
    const res = await call(`${PATH}?dryRun=1`)
    assert.equal(res.status, 200)
    assert.ok(res.body.rows.some((row) => row.dedupe_key === 'boilerlink:12891899'))
  })
})

test('CAMPUS_EVENTS_ENGAGE=boilerlink reads BoilerLink and the directory only; thespot alone skips the directory', async (t) => {
  t.mock.method(console, 'log', () => {})
  await withApp({ engageEnabled: ['boilerlink'] }, async ({ call, fetched, directoryReads }) => {
    const res = await call(`${PATH}?dryRun=1`)
    assert.equal(res.status, 200)
    assert.deepEqual([...new Set(fetched)], ['events.purdue.edu', 'events.iu.edu', 'boilerlink.purdue.edu'])
    assert.equal(directoryReads(), 1)
    assert.deepEqual(res.body.sources.map((s) => s.enabled), [true, true, true, false])
  })
  await withApp({ engageEnabled: ['thespot'] }, async ({ call, fetched, directoryReads }) => {
    const res = await call(`${PATH}?dryRun=1`)
    assert.equal(res.status, 200)
    assert.deepEqual([...new Set(fetched)], ['events.purdue.edu', 'events.iu.edu', 'thespot.indianapolis.iu.edu'])
    assert.equal(directoryReads(), 0, 'TheSpot needs no club directory')
  })
})

test('with a classifier, a run hands it the rows and answers its summary; a dry run leaves it alone', async (t) => {
  const lines = []
  t.mock.method(console, 'log', (line) => lines.push(line))
  const calls = []
  const classify = async (rows, context) => {
    calls.push({ rows: rows.length, client: Boolean(context.client) })
    return { rows, summary: { mode: 'shadow', reused: 3, asked: 14, answered: 14, failed: 0, deferred: 0 } }
  }
  await withApp({ classify }, async ({ call }) => {
    const dry = await call(`${PATH}?dryRun=1`)
    assert.deepEqual(dry.body.classify, { skipped: 'dry run' })
    assert.equal(calls.length, 0)

    const res = await call(PATH)
    assert.equal(res.status, 200)
    assert.deepEqual(calls, [{ rows: 17, client: true }])
    assert.equal(res.body.classify.mode, 'shadow')
    assert.match(lines.at(-1), /, jev shadow: 3 reused, 14 asked, 0 failed, 0 left for the next run in \d+ ms$/)
  })
})

test('a run already in flight answers 409, and the next one runs once it is done', async (t) => {
  t.mock.method(console, 'log', () => {})
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  let reached
  const firstFetch = new Promise((resolve) => {
    reached = resolve
  })
  let gated = true
  const gate = async () => {
    if (!gated) return
    gated = false
    reached()
    await held
  }
  await withApp({ gate }, async ({ call }) => {
    const first = call(`${PATH}?dryRun=1`)
    try {
      await firstFetch
      const second = await call(`${PATH}?dryRun=1`)
      assert.equal(second.status, 409)
      assert.deepEqual(second.body, { error: { message: 'A campus events ingest is already running.', status: 409 } })
    } finally {
      release()
    }
    assert.equal((await first).status, 200)
    assert.equal((await call(`${PATH}?dryRun=1`)).status, 200)
  })
})

test('a missing table answers campus_events_schema_missing; a transient failure warns and answers 503; anything else is a 500', async (t) => {
  t.mock.method(console, 'log', () => {})
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')))
  const missing = campusEventsTable({
    upsert: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.campus_events' in the schema cache" }, status: 404 }),
  })
  await withApp({ table: missing }, async ({ call, cronWarnings }) => {
    const res = await call(PATH)
    assert.equal(res.status, 503)
    assert.deepEqual(res.body, {
      error: { message: 'The shared campus events feed is not set up yet. Please try again later.', code: 'campus_events_schema_missing', status: 503 },
    })
    assert.deepEqual(cronWarnings, [])
    // The dry run still works without the table.
    assert.equal((await call(`${PATH}?dryRun=1`)).status, 200)
  })
  assert.ok(errors.some((line) => line.includes('db/supabase-campus-events.sql')))

  const gateway = campusEventsTable({ upsert: () => ({ data: null, error: { message: 'Gateway Timeout' }, status: 504 }) })
  await withApp({ table: gateway }, async ({ call, supabase, cronWarnings }) => {
    const res = await call(PATH)
    assert.equal(res.status, 503)
    assert.deepEqual(res.body, { error: { message: 'Campus events ingest skipped: the database is unavailable, the next run will retry.', status: 503 } })
    assert.equal(supabase.queriesOf('campus_events').length, 2, 'the upsert was retried once')
    assert.equal(cronWarnings.length, 1)
    assert.equal(cronWarnings[0].route, 'POST /api/internal/campus-events/ingest')
    assert.equal(cronWarnings[0].error.status, 504)
  })

  const denied = campusEventsTable({ upsert: () => ({ data: null, error: { code: '42501', message: 'permission denied for table campus_events' }, status: 401 }) })
  await withApp({ table: denied }, async ({ call, supabase, cronWarnings }) => {
    const res = await call(PATH)
    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { error: { message: 'Campus events ingest failed.', status: 500 } })
    assert.equal(supabase.queriesOf('campus_events').length, 1)
    assert.deepEqual(cronWarnings, [])
  })
})

// ── Downtown: White River State Park, behind CAMPUS_EVENTS_DOWNTOWN (#30) ────

test('POST ?dryRun=1 with CAMPUS_EVENTS_DOWNTOWN on reads the park once, answers its downtown rows and writes nothing', async (t) => {
  const lines = []
  t.mock.method(console, 'log', (line) => lines.push(line))
  await withApp({ downtownEnabled: true, now: WRSP_NOW }, async ({ call, supabase, fetched, fetchedUrls }) => {
    const res = await call(`${PATH}?dryRun=1`)
    assert.equal(res.status, 200)
    assert.equal(res.body.dryRun, true)
    assert.deepEqual(res.body.sources.map((s) => [s.key, s.enabled]), [
      ['purdue_events', true], ['iu_events', true], ['boilerlink', false], ['thespot', false], ['wrsp_events', true],
    ])
    const park = res.body.sources.at(-1)
    assert.deepEqual([park.ok, park.complete, park.pages, park.listings, park.rows], [true, true, 1, 19, 19])
    const downtown = res.body.rows.filter((row) => row.source_key === 'wrsp_events')
    assert.equal(downtown.length, 19)
    assert.ok(downtown.every((row) => row.venue_kind === 'downtown' && row.free_food === false))
    assert.equal(res.body.totals.venueKinds.downtown, 19)
    assert.equal(supabase.queries.length, 0)
    // One request to the park, with no query string (robots.txt disallows /*?).
    assert.deepEqual(fetchedUrls.filter((url) => url.includes('whiteriverstatepark.org')), ['https://whiteriverstatepark.org/wp-json/tribe/events/v1/events'])
    assert.deepEqual([...new Set(fetched)], ['events.purdue.edu', 'events.iu.edu', 'whiteriverstatepark.org'])
  })
  assert.match(lines.at(-1), /^\[campus-events\] dry run: purdue_events=9 iu_events=8 wrsp_events=19, 36 rows in \d+ ms$/)

  // Off, the default, the park is neither read nor in the answer.
  await withApp({ now: WRSP_NOW }, async ({ call, fetched }) => {
    const res = await call(`${PATH}?dryRun=1`)
    assert.deepEqual(res.body.sources.map((s) => s.key), ['purdue_events', 'iu_events', 'boilerlink', 'thespot'])
    assert.ok(!fetched.includes('whiteriverstatepark.org'))
  })
})

test('a run with CAMPUS_EVENTS_DOWNTOWN on before README step 49 skips the park and answers 200 for the rest', async (t) => {
  const lines = []
  t.mock.method(console, 'log', (line) => lines.push(line))
  const step49Missing = campusEventsTable({
    upsert: (chain) =>
      chain[0].args[0].some((row) => row.venue_kind === 'downtown')
        ? { data: null, error: { code: '23514', message: 'new row for relation "campus_events" violates check constraint "campus_events_venue_kind_check"' }, status: 400 }
        : { error: null },
  })
  await withApp({ downtownEnabled: true, now: WRSP_NOW, table: step49Missing }, async ({ call, supabase }) => {
    const res = await call(PATH)
    assert.equal(res.status, 200)
    assert.equal(res.body.upserted, 17)
    const park = res.body.sources.at(-1)
    assert.deepEqual([park.key, park.ok, park.schemaMissing], ['wrsp_events', false, 'db/supabase-campus-events-downtown.sql'])
    // The one row it tried, the campus rows, and the two campus sweeps.
    assert.deepEqual(supabase.queriesOf('campus_events').map((q) => operation(q.chain)), ['upsert', 'upsert', 'delete', 'delete'])
  })
  assert.match(lines.at(-1), /^\[campus-events\] run: purdue_events=9 iu_events=8 wrsp_events=skipped, 17 rows, 17 upserted in \d+ ms$/)
})

// ── GET /api/campus-events/free-food (issue #366) ───────────────────────────
// The signed-out Free Food page's read, booted on a small app the way
// server.mjs mounts it: ahead of any session, with recording limiters, the
// shared stale cache and a recording database whose only table is
// campus_events, so a read of anything else (a student's calendar_items)
// throws and fails the request. Rows are timed off the real clock, which the
// route reads.

const FREE_FOOD_PATH = '/api/campus-events/free-food'
const PUBLIC_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
const HOUR = 60 * 60 * 1000
const inHours = (hours) => new Date(Date.now() + hours * HOUR).toISOString()

let rowSeq = 0
function campusRow(overrides = {}) {
  rowSeq += 1
  return {
    id: `00000000-0000-4000-8000-${String(rowSeq).padStart(12, '0')}`,
    title: `Event ${rowSeq}`,
    description: 'Free pizza in the atrium',
    starts_at: inHours(26),
    ends_at: inHours(28),
    location: 'Campus Center 450',
    all_day: false,
    source_key: 'purdue_events',
    source_url: 'https://events.purdue.edu/event/pizza',
    category: 'social',
    free_food: true,
    venue_kind: 'indy_campus',
    open_to_all: true,
    series_key: `purdue_events:series${rowSeq}`,
    last_seen_at: inHours(-2),
    ...overrides,
  }
}

const titlesOf = (body) => body.items.map((item) => item.title)

async function withPublicApp({ rows = [], table, sharedEventsFeed = true, downtownEnabled = false, cache = createStaleCache({ log: { warn() {} } }) } = {}, run) {
  const supabase = fakeSupabase({ campus_events: table ?? (() => ({ data: rows, error: null })) })
  const limiterHits = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(
    createCampusEventsPublicRouter({
      supabase,
      publicReadIpRateLimit: limiter('public-read-ip'),
      publicReadRateLimit: limiter('public-read'),
      getCached: (key, ttlMs, producer) => cache.get(key, ttlMs, producer),
      sharedEventsFeed,
      downtownEnabled,
    }),
  )
  app.use((_req, res) => res.status(404).json(NOT_FOUND))

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = async (path = FREE_FOOD_PATH, headers = {}) => {
    const response = await fetch(base + path, { headers })
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  try {
    await run({ get, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('free food: anyone gets the upcoming campus events with free food, in the calendar item shape, cacheable and cookie-free', async () => {
  const pizza = campusRow({ title: 'Pizza social', source_key: 'iu_events', source_url: 'https://events.iu.edu/event/pizza' })
  const breakfast = campusRow({ title: 'Boiler Fuel Up', starts_at: inHours(2), ends_at: inHours(4) })
  await withPublicApp({ rows: [pizza, breakfast] }, async ({ get, supabase, limiterHits }) => {
    const res = await get()
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.deepEqual(titlesOf(res.body), ['Boiler Fuel Up', 'Pizza social'])
    assert.deepEqual(res.body.items[1], {
      id: `campus:${pizza.id}`,
      sourceId: null,
      title: 'Pizza social',
      description: 'Free pizza in the atrium',
      startTime: pizza.starts_at,
      endTime: pizza.ends_at,
      location: 'Campus Center 450',
      category: 'campus_event',
      externalUid: null,
      sourceType: 'campus',
      allDay: false,
      freeFood: true,
      shared: true,
      sourceKey: 'iu_events',
      sourceLabel: 'IU event',
      sourceUrl: 'https://events.iu.edu/event/pizza',
    })
    assert.equal(res.headers.get('cache-control'), PUBLIC_CACHE)
    assert.equal(res.headers.get('set-cookie'), null)
    // Both public-read buckets, the per-address cap first.
    assert.deepEqual(limiterHits, [`public-read-ip GET ${FREE_FOOD_PATH}`, `public-read GET ${FREE_FOOD_PATH}`])
    // The database is asked for free food alone.
    const [read] = supabase.queriesOf('campus_events')
    assert.ok(hasCall(read.chain, 'eq', 'free_food', true))
  })
})

test('free food: never a row without free food, over, stale, out of reach or members only, even when the database answers one', async () => {
  const rows = [
    campusRow({ title: 'Pizza social' }),
    campusRow({ title: 'Career fair', free_food: false }),
    campusRow({ title: 'Food not known', free_food: null }),
    campusRow({ title: 'Breakfast that ended', starts_at: inHours(-3), ends_at: inHours(-1) }),
    campusRow({ title: 'Pizza nobody has listed for two days', last_seen_at: inHours(-48) }),
    campusRow({ title: 'Pizza at Mackey', venue_kind: 'west_lafayette' }),
    campusRow({ title: 'Away game tailgate', venue_kind: 'elsewhere' }),
    campusRow({ title: 'Officers dinner', open_to_all: false }),
  ]
  await withPublicApp({ rows }, async ({ get }) => {
    const res = await get()
    assert.equal(res.status, 200)
    assert.deepEqual(titlesOf(res.body), ['Pizza social'])
  })
})

test('free food: nothing about the caller reaches the read or the answer, a session cookie and query parameters included', async () => {
  // A cache that never holds anything, so every request reads.
  const uncached = { get: (_key, _ttlMs, producer) => producer() }
  await withPublicApp({ rows: [campusRow({ title: 'Pizza social' })], cache: uncached }, async ({ get, supabase }) => {
    const plain = await get()
    const asStudent = await get(`${FREE_FOOD_PATH}?userId=11111111-1111-4111-8111-111111111111&shared=0&categories=deadline&limit=1`, {
      cookie: 'pih.sid=s%3AabcDEF123.signature-part',
    })
    assert.equal(asStudent.status, 200)
    assert.deepEqual(asStudent.body, plain.body)
    assert.equal(asStudent.headers.get('set-cookie'), null)
    assert.equal(asStudent.headers.get('cache-control'), PUBLIC_CACHE)

    // Two reads of campus_events, the same both times but for the clock, and
    // of no other table.
    assert.deepEqual(supabase.queries.map((query) => query.table), ['campus_events', 'campus_events'])
    const withoutClock = (query) => JSON.stringify(query.chain).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>')
    assert.equal(withoutClock(supabase.queries[1]), withoutClock(supabase.queries[0]))
    assert.ok(!JSON.stringify(supabase.queries).includes('user_id'))
  })
})

test('free food: one read serves this process for a minute, and the rows are planned per request', async () => {
  let clock = Date.now()
  const cache = createStaleCache({ now: () => clock, log: { warn() {} } })
  await withPublicApp({ rows: [campusRow({ title: 'Pizza social' })], cache }, async ({ get, supabase }) => {
    for (let i = 0; i < 5; i += 1) assert.deepEqual(titlesOf((await get()).body), ['Pizza social'])
    assert.equal(supabase.queriesOf('campus_events').length, 1)
    clock += 61 * 1000
    await get()
    assert.equal(supabase.queriesOf('campus_events').length, 2)
  })

  // The cache holds rows, not answers: a row that ended while it sat there is
  // dropped from the next answer, with no read.
  const cachedEarlier = [
    campusRow({ title: 'Coffee hour that just ended', starts_at: inHours(-2), ends_at: inHours(-0.01) }),
    campusRow({ title: 'Pizza social' }),
  ]
  await withPublicApp({ cache: { get: async () => cachedEarlier } }, async ({ get, supabase }) => {
    assert.deepEqual(titlesOf((await get()).body), ['Pizza social'])
    assert.equal(supabase.queries.length, 0)
  })
})

test('free food: with CAMPUS_EVENTS_FEED off the answer is none and nothing is read', async () => {
  await withPublicApp({ rows: [campusRow({ title: 'Pizza social' })], sharedEventsFeed: false }, async ({ get, supabase }) => {
    const res = await get()
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, items: [] })
    assert.equal(res.headers.get('cache-control'), PUBLIC_CACHE)
    assert.equal(supabase.queries.length, 0)
  })
})

test('free food: a failed read is an error that is never cached, not an empty list; the next request reads again', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  let failure = { code: 'PGRST205', message: "Could not find the table 'public.campus_events' in the schema cache (public free food test)" }
  const table = () => (failure ? { data: null, error: failure } : { data: [campusRow({ title: 'Pizza social' })], error: null })
  await withPublicApp({ table }, async ({ get, supabase }) => {
    const missing = await get()
    assert.equal(missing.status, 503)
    assert.deepEqual(missing.body, {
      error: { message: 'The shared campus events feed is not set up yet. Please try again later.', code: 'campus_events_schema_missing', status: 503 },
    })
    assert.equal(missing.headers.get('cache-control'), 'no-store')
    assert.ok(logged.mock.calls.some((call) => String(call.arguments[0]).includes('db/supabase-campus-events.sql')))

    failure = { code: '57014', message: 'canceling statement due to statement timeout' }
    const slow = await get()
    assert.equal(slow.status, 500)
    assert.deepEqual(slow.body, { error: { message: 'Could not load free food events. Please try again.', status: 500 } })
    assert.equal(slow.headers.get('cache-control'), 'no-store')
    assert.ok(logged.mock.calls.some((call) => call.arguments.join(' ') === 'campus_events DB error: 57014 canceling statement due to statement timeout'))

    failure = null
    const recovered = await get()
    assert.equal(recovered.status, 200)
    assert.deepEqual(titlesOf(recovered.body), ['Pizza social'])
    assert.equal(supabase.queriesOf('campus_events').length, 3)
  })
})

test('free food: once a read has worked, a failed refresh serves the last good rows', async () => {
  let clock = Date.now()
  const cache = createStaleCache({ now: () => clock, log: { warn() {} } })
  let failing = false
  const table = () => (failing ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } : { data: [campusRow({ title: 'Pizza social' })], error: null })
  await withPublicApp({ table, cache }, async ({ get, supabase }) => {
    assert.deepEqual(titlesOf((await get()).body), ['Pizza social'])
    failing = true
    clock += 61 * 1000
    const res = await get()
    assert.equal(res.status, 200)
    assert.deepEqual(titlesOf(res.body), ['Pizza social'])
    assert.equal(supabase.queriesOf('campus_events').length, 2)
  })
})

// Issue #30: signed out, a downtown row with free food is listed, as Downtown,
// only while CAMPUS_EVENTS_DOWNTOWN is on, the same rule as the signed-in read.
test('free food: a downtown row is listed as Downtown with CAMPUS_EVENTS_DOWNTOWN on, and left out with it off', async () => {
  const rows = [
    campusRow({ title: 'Pizza social' }),
    campusRow({
      title: 'Free pizza at the museum',
      source_key: 'wrsp_events',
      venue_kind: 'downtown',
      source_url: 'https://whiteriverstatepark.org/event/pizza/',
      starts_at: inHours(30),
      ends_at: inHours(32),
    }),
  ]
  await withPublicApp({ rows, downtownEnabled: true }, async ({ get }) => {
    const res = await get()
    assert.equal(res.status, 200)
    assert.deepEqual(titlesOf(res.body), ['Pizza social', 'Free pizza at the museum'])
    assert.deepEqual(
      [res.body.items[1].sourceKey, res.body.items[1].sourceLabel, res.body.items[1].sourceUrl],
      ['wrsp_events', 'Downtown', 'https://whiteriverstatepark.org/event/pizza/'],
    )
  })
  await withPublicApp({ rows }, async ({ get, supabase }) => {
    const res = await get()
    assert.equal(res.status, 200)
    assert.deepEqual(titlesOf(res.body), ['Pizza social'])
    assert.equal(res.headers.get('cache-control'), PUBLIC_CACHE)
    // The same one read as before the source existed.
    assert.deepEqual(supabase.queries.map((query) => query.table), ['campus_events'])
  })
})
