import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { createCampusEventsRouter } from '../../src/routes/campusEvents.mjs'
import { fakeSupabase, operation } from './fakeSupabase.mjs'

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
}

function campusEventsTable({ upsert = () => ({ error: null }) } = {}) {
  return (chain) => {
    const op = operation(chain)
    if (op === 'upsert') return upsert(chain)
    if (op === 'delete') return { count: 0, error: null }
    throw new Error(`unexpected ${op} on campus_events`)
  }
}

async function withApp({ cronSecret = CRON_SECRET, engageEnabled = false, table = campusEventsTable(), directory = { ok: true, clubs: [] }, gate } = {}, run) {
  const supabase = fakeSupabase({ campus_events: table })
  const fetched = []
  const cronWarnings = []
  let directoryReads = 0
  const fetchImpl = async (url) => {
    const { hostname } = new URL(String(url))
    fetched.push(hostname)
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
      ingestOptions: { fetchImpl, now: NOW, sleep: async () => {}, log: { log() {}, error() {}, warn() {} } },
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
    await run({ call, supabase, fetched, cronWarnings, directoryReads: () => directoryReads })
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
      assert.equal(res.body.rows.length, 18)
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
    assert.equal(res.body.upserted, 18)
    assert.equal(res.body.rows, undefined)
    const ops = supabase.queriesOf('campus_events').map((q) => operation(q.chain))
    assert.deepEqual(ops, ['upsert', 'delete', 'delete'])
  })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[campus-events\] run: purdue_events=9 iu_events=9, 18 rows, 18 upserted in \d+ ms$/)
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
