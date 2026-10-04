import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createAnalyticsRouter } from '../../src/routes/analytics.mjs'
import { normalizeAnalyticsBatch } from '../../src/analytics.mjs'
import { fakeSupabase, operation } from './fakeSupabase.mjs'

// Issue #191: POST /api/usage/events, the first-party usage beacon (issue
// #51), as a feature router, booted on a small app with the body handling
// server.mjs runs ahead of it, a fake session, a recording limiter and a
// recording database.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com', analytics_opt_out: false }
const OPTED_OUT = { id: '22222222-2222-4222-8222-222222222222', email: 'quiet@example.com', analytics_opt_out: true }
const SIGNED_OUT = { error: { message: 'You must sign in to access this resource.', status: 401 } }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PAYLOAD = { events: [{ event_name: 'page_view', page: '/dining' }, { event_name: 'page_view', page: '/board' }] }
// The content type navigator.sendBeacon gives a string body.
const BEACON_TYPE = 'text/plain;charset=UTF-8'
const LIMITED = 'analyticsRateLimit POST /api/usage/events'

async function withApp({ user = STUDENT, insertError = null } = {}, run) {
  const supabase = fakeSupabase({ analytics_events: () => ({ data: null, error: insertError }) })
  const limiterHits = []
  const app = express()
  // The app-level body handling server.mjs registers ahead of every route: a
  // JSON body arrives parsed, and one no parser claims arrives as {} (#291).
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {}
    next()
  })
  app.use(
    createAnalyticsRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json(SIGNED_OUT)
        req.currentUser = user
        next()
      },
      analyticsRateLimit: (req, _res, next) => {
        limiterHits.push(`analyticsRateLimit ${req.method} ${req.path}`)
        next()
      },
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  // A JSON body by default; { type, text } sends a raw body, as the beacon does.
  const send = async (body, { type = 'application/json', text = JSON.stringify(body) } = {}) => {
    const response = await fetch(`${base}/api/usage/events`, { method: 'POST', headers: { 'Content-Type': type }, body: text })
    const raw = await response.text()
    const json = (response.headers.get('content-type') || '').includes('application/json')
    return { status: response.status, body: raw === '' ? null : json ? JSON.parse(raw) : raw }
  }
  try {
    await run({ send, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// The rows of the one bare insert a batch makes.
function insertedRows(supabase) {
  const queries = supabase.queriesOf('analytics_events')
  assert.equal(queries.length, 1, 'one insert per batch')
  assert.equal(operation(queries[0].chain), 'insert')
  assert.equal(queries[0].chain.length, 1, 'no select or filter after the insert')
  return queries[0].chain[0].args[0]
}

// Each row is normalizeAnalyticsBatch's own output for the body, plus its own
// UUID, the signed-in student and one ISO timestamp for the whole batch.
function assertRowsFor(rows, body, user) {
  const expected = normalizeAnalyticsBatch(body)
  assert.equal(rows.length, expected.length, 'one row per event')
  const timestamp = rows[0].created_at
  assert.equal(new Date(timestamp).toISOString(), timestamp, 'created_at is an ISO string')
  rows.forEach((row, i) => {
    assert.match(row.id, UUID_V4)
    assert.deepEqual(row, { id: row.id, user_id: user.id, ...expected[i], created_at: timestamp })
  })
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'every row gets its own id')
}

test('signed out, the beacon answers 401 with no query, and the limiter counted it first', async () => {
  await withApp({ user: null }, async ({ send, supabase, limiterHits }) => {
    const answer = await send(PAYLOAD)
    assert.equal(answer.status, 401)
    assert.deepEqual(answer.body, SIGNED_OUT)
    assert.deepEqual(limiterHits, [LIMITED], 'the limiter runs ahead of requireAuth, so a signed-out flood is metered too')
    assert.equal(supabase.queries.length, 0)
  })
})

test('an opted-out student gets 204 and nothing is stored, whatever the body', async () => {
  await withApp({ user: OPTED_OUT }, async ({ send, supabase, limiterHits }) => {
    for (const answer of [
      await send(PAYLOAD),
      await send(null, { type: BEACON_TYPE, text: JSON.stringify(PAYLOAD) }),
      await send({}),
    ]) {
      assert.equal(answer.status, 204)
      assert.equal(answer.body, null)
    }
    assert.equal(supabase.queries.length, 0)
    assert.deepEqual(limiterHits, [LIMITED, LIMITED, LIMITED])
  })
})

test('a JSON batch is one insert of one row per event for the signed-in student, answered 204', async () => {
  await withApp({}, async ({ send, supabase, limiterHits }) => {
    const answer = await send(PAYLOAD)
    assert.equal(answer.status, 204)
    assert.equal(answer.body, null)
    assertRowsFor(insertedRows(supabase), PAYLOAD, STUDENT)
    assert.deepEqual(limiterHits, [LIMITED])
  })
})

test('a sendBeacon flush (a text/plain JSON string) is the same insert; text that is not JSON is a 400', async () => {
  await withApp({}, async ({ send, supabase }) => {
    const answer = await send(null, { type: BEACON_TYPE, text: JSON.stringify(PAYLOAD) })
    assert.equal(answer.status, 204)
    assertRowsFor(insertedRows(supabase), PAYLOAD, STUDENT)
  })
  await withApp({}, async ({ send, supabase }) => {
    const answer = await send(null, { type: BEACON_TYPE, text: '{"events": [' })
    assert.equal(answer.status, 400)
    assert.deepEqual(answer.body, { error: { message: 'Invalid analytics payload.', status: 400 } })
    assert.equal(supabase.queries.length, 0)
  })
})

test("an invalid batch answers normalizeAnalyticsBatch's message as the 400, with no query", async () => {
  const tooMany = { events: Array.from({ length: 21 }, () => ({ event_name: 'page_view', page: '/' })) }
  await withApp({}, async ({ send, supabase }) => {
    for (const [body, message] of [
      [{}, 'Send a non-empty events array.'],
      [tooMany, 'Send at most 20 events per request.'],
      [{ events: [{ event_name: 'page_view' }, { event_name: 'keystroke' }] }, 'Unknown analytics event name.'],
    ]) {
      const answer = await send(body)
      assert.equal(answer.status, 400, message)
      assert.deepEqual(answer.body, { error: { message, status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('a failed insert is logged and answered 202 { ok: false }, never an error to the student', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.analytics_events' in the schema cache" }
  await withApp({ insertError: missing }, async ({ send, supabase }) => {
    const answer = await send(PAYLOAD)
    assert.equal(answer.status, 202)
    assert.deepEqual(answer.body, { ok: false })
    assertRowsFor(insertedRows(supabase), PAYLOAD, STUDENT)
  })
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [['[/api/usage/events] insert failed:', missing.message]])
})
