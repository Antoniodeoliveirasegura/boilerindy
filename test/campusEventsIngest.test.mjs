// Tests for the shared campus events ingest shell (issue #30): page URLs,
// paging, the one retry, the dry run, the upsert and the per-source sweep.
// Nothing leaves the machine: fetch is a fake that answers each source's host
// with the 2026-10-17 fixtures (see test/sharedEvents.test.mjs), and the
// database is the recording fake the router tests use.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DOWNTOWN_SQL_FILE,
  MAX_PAGES,
  PAGE_DELAY_MS,
  UPSERT_BATCH_SIZE,
  campusYmd,
  engagePageUrl,
  fetchSourceListings,
  inTribeWindow,
  isDowntownCheckViolation,
  liveWhalePageUrl,
  localistPageUrl,
  runCampusEventsIngest,
  tribePageUrl,
} from '../src/campusEventsIngest.mjs'
import { sourceByKey } from '../src/sharedEvents.mjs'
import { fakeSupabase, hasCall, operation } from './routes/fakeSupabase.mjs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const LOCALIST = fixture('campus-events-localist.json')
const LIVEWHALE = fixture('campus-events-livewhale.json')
const BOILERLINK = fixture('campus-events-boilerlink.json')
const THESPOT = fixture('campus-events-thespot.json')
// White River State Park's list as fetched at 17:30 in Indianapolis on 2026-10-24.
const WRSP = fixture('campus-events-wrsp.json')
const WRSP_NOW = new Date('2026-10-24T21:30:00.000Z')

const NOW = new Date('2026-10-17T12:00:00.000Z')
const RUN_AT = NOW.toISOString()
const quiet = { log() {}, error() {}, warn() {} }
const noSleep = async () => {}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Answers each host from `pages` (a function of the URL) and records every request.
function fakeFetch(answer) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers })
    return answer(new URL(String(url)), calls.length)
  }
  return { fetchImpl, calls }
}

const bySource = (overrides = {}) => (url) => {
  const routes = {
    'events.purdue.edu': () => json(LOCALIST),
    'events.iu.edu': () => json(LIVEWHALE),
    'boilerlink.purdue.edu': () => json(BOILERLINK),
    'thespot.indianapolis.iu.edu': () => json(THESPOT),
    'whiteriverstatepark.org': () => json(WRSP),
    ...overrides,
  }
  const route = routes[url.hostname]
  if (!route) throw new Error(`unexpected fetch of ${url}`)
  return route(url)
}

// campus_events as the fake sees it: upserts and deletes answered, every call recorded.
function database({ upsert = () => ({ error: null }), sweep = () => ({ count: 2, error: null }) } = {}) {
  return fakeSupabase({
    campus_events: (chain) => {
      const op = operation(chain)
      if (op === 'upsert') return upsert(chain)
      if (op === 'delete') return sweep(chain)
      throw new Error(`unexpected ${op} on campus_events`)
    },
  })
}

const upsertedRows = (supabase) =>
  supabase.queriesOf('campus_events').filter((q) => operation(q.chain) === 'upsert').flatMap((q) => q.chain.find((c) => c.method === 'upsert').args[0])
const sweeps = (supabase) => supabase.queriesOf('campus_events').filter((q) => operation(q.chain) === 'delete')

// ── URLs ────────────────────────────────────────────────────────────────────

test('the page URLs are the ones verified on 2026-10-17', () => {
  assert.equal(
    localistPageUrl(sourceByKey('purdue_events'), 1),
    'https://events.purdue.edu/api/2/events?group_id=46197580344207&days=120&pp=100&distinct=true&page=1',
  )
  assert.equal(
    liveWhalePageUrl(sourceByKey('iu_events'), 2, NOW),
    'https://events.iu.edu/live/json/events/category/IU%20Indianapolis/near_location/39.774,-86.1765/near_distance/1/start_date/2026-10-17/end_date/2026-11-17/response_fields/location,tags,summary,group_title,event_types?page=2',
  )
  assert.equal(
    engagePageUrl(sourceByKey('thespot'), 200, NOW),
    'https://thespot.indianapolis.iu.edu/api/discovery/event/search?endsAfter=2026-10-17T12%3A00%3A00.000Z&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=100&skip=200&query=',
  )
})

test('the LiveWhale window starts on the campus date, not the UTC one', () => {
  // 10 PM in Indianapolis is already the next day in UTC.
  const lateEvening = new Date('2026-10-18T02:00:00.000Z')
  assert.equal(campusYmd(lateEvening), '2026-10-17')
  assert.match(liveWhalePageUrl(sourceByKey('iu_events'), 1, lateEvening), /start_date\/2026-10-17\/end_date\/2026-11-17\//)
})

// ── Paging ──────────────────────────────────────────────────────────────────

test('a source is read page by page, a second apart, until its last page', async () => {
  const [first, second] = [LIVEWHALE.data.slice(0, 8), LIVEWHALE.data.slice(8)]
  const { fetchImpl, calls } = fakeFetch((url) =>
    json({ meta: { total_pages: 2 }, data: url.searchParams.get('page') === '1' ? first : second }),
  )
  const sleeps = []
  const result = await fetchSourceListings(sourceByKey('iu_events'), { fetchImpl, now: NOW, sleep: async (ms) => sleeps.push(ms), log: quiet })
  assert.deepEqual(result, { listings: LIVEWHALE.data, pages: 2, complete: true, error: null })
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('page')), ['1', '2'])
  assert.deepEqual(sleeps, [PAGE_DELAY_MS])
  assert.equal(calls[0].headers['user-agent'], 'BoilerIndy campus app (+https://www.boilerindy.app)')
})

test('Engage pages by skip until the count is reached', async () => {
  const { fetchImpl, calls } = fakeFetch((url) =>
    json({ '@odata.count': 112, value: url.searchParams.get('skip') === '0' ? BOILERLINK.value : [] }),
  )
  const result = await fetchSourceListings(sourceByKey('boilerlink'), { fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('skip')), ['0', '100'])
  assert.equal(result.complete, true)
  assert.equal(result.listings.length, BOILERLINK.value.length)
})

test('a page that fails transiently is retried once; a failure that is not transient ends the fetch', async () => {
  const retried = fakeFetch((url, n) => (n === 1 ? json({}, 503) : json(LOCALIST)))
  const ok = await fetchSourceListings(sourceByKey('purdue_events'), { fetchImpl: retried.fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.equal(retried.calls.length, 2)
  assert.equal(ok.complete, true)
  assert.equal(ok.listings.length, LOCALIST.events.length)

  const broken = fakeFetch(() => json({ message: 'nope' }, 500))
  const failed = await fetchSourceListings(sourceByKey('purdue_events'), { fetchImpl: broken.fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.equal(broken.calls.length, 1)
  assert.equal(failed.complete, false)
  assert.equal(failed.pages, 0)
  assert.match(failed.error, /purdue_events responded 500/)

  const html = fakeFetch(() => new Response('<html>maintenance</html>', { status: 200 }))
  const notJson = await fetchSourceListings(sourceByKey('purdue_events'), { fetchImpl: html.fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.equal(notJson.complete, false)
  assert.match(notJson.error, /invalid JSON body/)

  const wrongShape = fakeFetch(() => json({ data: [] }))
  const shape = await fetchSourceListings(sourceByKey('purdue_events'), { fetchImpl: wrongShape.fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.equal(shape.complete, false)
  assert.match(shape.error, /something other than its JSON on page 1/)
})

test('a source that never stops paging is cut at its page cap and reported incomplete', async () => {
  const { fetchImpl, calls } = fakeFetch(() => json({ meta: { total_pages: 999 }, data: LIVEWHALE.data.slice(0, 1) }))
  const result = await fetchSourceListings(sourceByKey('iu_events'), { fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.equal(calls.length, MAX_PAGES.livewhale)
  assert.equal(result.complete, false)
  assert.match(result.error, /more than 20 pages/)
})

// ── Runs ────────────────────────────────────────────────────────────────────

test('a dry run fetches the two calendars, leaves Engage alone and touches no database', async () => {
  const { fetchImpl, calls } = fakeFetch(bySource())
  const summary = await runCampusEventsIngest({ dryRun: true, fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.deepEqual([...new Set(calls.map((c) => new URL(c.url).hostname))], ['events.purdue.edu', 'events.iu.edu'])
  assert.equal(summary.ok, true)
  assert.equal(summary.dryRun, true)
  assert.equal(summary.startedAt, RUN_AT)
  assert.deepEqual(summary.sources.map(({ key, enabled, ok, complete, rows }) => ({ key, enabled, ok, complete, rows })), [
    { key: 'purdue_events', enabled: true, ok: true, complete: true, rows: 9 },
    { key: 'iu_events', enabled: true, ok: true, complete: true, rows: 8 },
    { key: 'boilerlink', enabled: false, ok: undefined, complete: undefined, rows: undefined },
    { key: 'thespot', enabled: false, ok: undefined, complete: undefined, rows: undefined },
  ])
  assert.equal(summary.rows.length, 17)
  assert.equal(summary.totals.rows, 17)
  assert.ok(summary.rows.every((row) => !('last_seen_at' in row)))
  assert.equal(summary.upserted, undefined)
  assert.ok(summary.dropped.some((d) => d.title === '93rd Annual Purdue Christmas Show' && d.why === 'far'))
})

test('a run upserts every row on dedupe_key with this run as last_seen_at, then sweeps each source', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  const supabase = database()
  const summary = await runCampusEventsIngest({ client: supabase, fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  const [upsert] = supabase.queriesOf('campus_events').filter((q) => operation(q.chain) === 'upsert')
  assert.ok(hasCall(upsert.chain, 'upsert', upsertedRows(supabase), { onConflict: 'dedupe_key' }))
  const rows = upsertedRows(supabase)
  assert.equal(rows.length, 17)
  assert.ok(rows.every((row) => row.last_seen_at === RUN_AT && !('classifier' in row)))
  assert.equal(summary.upserted, 17)
  assert.equal(summary.rows, undefined)

  const swept = sweeps(supabase)
  assert.equal(swept.length, 2)
  for (const [i, key] of ['purdue_events', 'iu_events'].entries()) {
    assert.ok(hasCall(swept[i].chain, 'delete', { count: 'exact' }))
    assert.ok(hasCall(swept[i].chain, 'eq', 'source_key', key))
    assert.ok(hasCall(swept[i].chain, 'lt', 'last_seen_at', RUN_AT))
  }
  assert.deepEqual(summary.sources.slice(0, 2).map((s) => s.swept), [2, 2])
})

test('with Engage on, BoilerLink and TheSpot join, the club directory names Indianapolis orgs, and the cross-post collapses', async () => {
  const { fetchImpl, calls } = fakeFetch(bySource())
  const clubs = [{ id: '398688', indianapolis: true }, { id: '398920', indianapolis: true }, { id: '420527', indianapolis: true }]
  const summary = await runCampusEventsIngest({ dryRun: true, engageEnabled: true, clubs, fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.deepEqual([...new Set(calls.map((c) => new URL(c.url).hostname))], [
    'events.purdue.edu', 'events.iu.edu', 'boilerlink.purdue.edu', 'thespot.indianapolis.iu.edu',
  ])
  assert.deepEqual(summary.sources.map((s) => s.enabled), [true, true, true, true])
  assert.deepEqual(summary.sources[2].keptBy, { place: 5, org: 3, near: 1 })
  assert.deepEqual(summary.collapsed, [{ kept: 'boilerlink:12728673', dropped: 'thespot:12728562', title: 'Weekly Badminton Club Hours' }])
  assert.equal(summary.rows.length, 31)
})

test('with only BoilerLink named, TheSpot is never fetched', async () => {
  const { fetchImpl, calls } = fakeFetch(bySource())
  const summary = await runCampusEventsIngest({ dryRun: true, engageEnabled: ['boilerlink'], fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.deepEqual([...new Set(calls.map((c) => new URL(c.url).hostname))], ['events.purdue.edu', 'events.iu.edu', 'boilerlink.purdue.edu'])
  assert.deepEqual(summary.sources.map((s) => s.enabled), [true, true, true, false])
  assert.deepEqual(summary.collapsed, [])
})

test('a source that fails is reported and not swept; the rest of the run goes on', async () => {
  const { fetchImpl } = fakeFetch(bySource({ 'events.iu.edu': () => json({ message: 'down' }, 500) }))
  const supabase = database()
  const summary = await runCampusEventsIngest({ client: supabase, fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  const iu = summary.sources.find((s) => s.key === 'iu_events')
  assert.equal(iu.ok, false)
  assert.equal(iu.complete, false)
  assert.match(iu.error, /iu_events responded 500/)
  assert.equal(iu.swept, undefined)
  assert.equal(summary.upserted, 9)
  assert.deepEqual(sweeps(supabase).map((q) => q.chain.find((c) => c.method === 'eq').args[1]), ['purdue_events'])
})

test('a source that answers no listings is not swept, so an empty answer cannot wipe it', async () => {
  const { fetchImpl } = fakeFetch(bySource({ 'events.purdue.edu': () => json({ events: [], page: { total: 1 } }) }))
  const supabase = database()
  const summary = await runCampusEventsIngest({ client: supabase, fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.equal(summary.sources[0].complete, true)
  assert.equal(summary.sources[0].listings, 0)
  assert.deepEqual(sweeps(supabase).map((q) => q.chain.find((c) => c.method === 'eq').args[1]), ['iu_events'])
})

test('a failed sweep is logged and left to the next run', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  const errors = []
  const supabase = database({ sweep: () => ({ data: null, error: { message: 'Gateway Timeout' }, status: 504 }) })
  const log = { ...quiet, error: (...args) => errors.push(args.join(' ')) }
  const summary = await runCampusEventsIngest({ client: supabase, fetchImpl, now: NOW, sleep: noSleep, log })
  assert.equal(summary.ok, true)
  assert.equal(summary.upserted, 17)
  assert.match(summary.sources[0].sweepError, /campus_events sweep: Gateway Timeout \(HTTP 504\)/)
  assert.equal(errors.length, 2)
})

test('an upsert that fails transiently is retried once; a second failure, or a missing table, rejects', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  let attempts = 0
  const flaky = database({ upsert: () => (++attempts === 1 ? { data: null, error: { message: 'Gateway Timeout' }, status: 504 } : { error: null }) })
  const summary = await runCampusEventsIngest({ client: flaky, fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.equal(attempts, 2)
  assert.equal(summary.upserted, 17)

  const down = database({ upsert: () => ({ data: null, error: { message: 'Gateway Timeout' }, status: 504 }) })
  await assert.rejects(runCampusEventsIngest({ client: down, fetchImpl, now: NOW, sleep: noSleep, log: quiet }), (error) => {
    assert.equal(error.name, 'SupabaseQueryError')
    assert.equal(error.status, 504)
    return true
  })
  assert.equal(sweeps(down).length, 0, 'no sweep after a failed write')

  const missing = database({
    upsert: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.campus_events' in the schema cache" }, status: 404 }),
  })
  await assert.rejects(runCampusEventsIngest({ client: missing, fetchImpl, now: NOW, sleep: noSleep, log: quiet }), { code: 'PGRST205' })
  await assert.rejects(runCampusEventsIngest({ fetchImpl, now: NOW, sleep: noSleep, log: quiet }), /needs a client/)
})

// Issue #16: each row says which Engage organization listed it, and a run
// writes that on every row, so the first run after README step 48 fills the
// rows already stored. Until step 48 adds the column the run must still work.
test('a run writes organization_key on every row: the club on BoilerLink rows, null on the calendars', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  const supabase = database()
  const summary = await runCampusEventsIngest({ client: supabase, engageEnabled: ['boilerlink'], fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  const rows = upsertedRows(supabase)
  assert.ok(rows.every((row) => 'organization_key' in row))
  const keyed = rows.filter((row) => row.source_key === 'boilerlink')
  assert.equal(keyed.length, 9)
  assert.ok(keyed.every((row) => /^boilerlink:[1-9][0-9]*$/.test(row.organization_key)), keyed.map((row) => row.organization_key).join())
  assert.ok(keyed.some((row) => row.organization_key === 'boilerlink:383441')) // SHPE
  assert.ok(rows.filter((row) => row.source_key !== 'boilerlink').every((row) => row.organization_key === null))
  assert.equal(summary.organizationKeys, 'written')
})

test('before README step 48 the run writes its rows without organization_key, names the file once and says so', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const { fetchImpl } = fakeFetch(bySource())
  const missingColumn = {
    code: 'PGRST204',
    message: "Could not find the 'organization_key' column of 'campus_events' in the schema cache",
  }
  const attempts = []
  const supabase = database({
    upsert: (chain) => {
      const batch = chain.find((call) => call.method === 'upsert').args[0]
      const named = batch.some((row) => 'organization_key' in row)
      attempts.push(named)
      return named ? { data: null, error: missingColumn, status: 400 } : { error: null }
    },
  })
  const classify = async (rows) => rows.map((row, i) => (i === 0 ? { ...row, classifier: { model: 'jev-test' } } : row))
  const summary = await runCampusEventsIngest({ client: supabase, engageEnabled: ['boilerlink'], fetchImpl, now: NOW, sleep: noSleep, log: quiet, classify })
  // The first batch is tried once with the column, then every batch goes up without it.
  assert.deepEqual(attempts, [true, false, false])
  assert.equal(summary.ok, true)
  assert.equal(summary.upserted, 26)
  assert.equal(summary.organizationKeys, 'column_missing')
  assert.equal(sweeps(supabase).length, 3, 'the sweep still runs')
  assert.equal(logged.mock.callCount(), 1)
  assert.match(logged.mock.calls[0].arguments[0], /^\[club_follows\] schema missing: run db\/supabase-club-follows\.sql/)

  // Another missing column is not this one: the run fails as before.
  const other = database({ upsert: () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'classifier' column of 'campus_events' in the schema cache" }, status: 400 }) })
  await assert.rejects(runCampusEventsIngest({ client: other, fetchImpl, now: NOW, sleep: noSleep, log: quiet }), { code: 'PGRST204' })
})

test('the classify hook sees the planned rows; rows it answered are written apart from rows it did not', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  const supabase = database()
  const verdict = { model: 'jev-test', classified_at: RUN_AT }
  let seen = null
  const classify = async (rows) => {
    seen = rows
    return rows.map((row, i) => (i % 2 === 0 ? { ...row, free_food: true, classifier: verdict } : row))
  }
  await runCampusEventsIngest({ client: supabase, fetchImpl, now: NOW, sleep: noSleep, log: quiet, classify })
  assert.equal(seen.length, 17)
  const batches = supabase.queriesOf('campus_events').filter((q) => operation(q.chain) === 'upsert').map((q) => q.chain[0].args[0])
  assert.equal(batches.length, 2)
  assert.ok(batches[0].every((row) => !('classifier' in row)))
  assert.ok(batches[1].every((row) => row.classifier === verdict && row.free_food === true))
  assert.equal(batches[0].length + batches[1].length, 17)

  await assert.rejects(
    runCampusEventsIngest({ client: database(), fetchImpl, now: NOW, sleep: noSleep, log: quiet, classify: async () => undefined }),
    /classify must resolve with the rows/,
  )
})

test('the classify hook gets the database and the free food the sources state; its summary is reported, the totals recounted', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  const supabase = database()
  let context = null
  const classify = async (rows, ctx) => {
    context = ctx
    return {
      rows: rows.map((row) => ({ ...row, free_food: true, classifier: { model: 'jev-test' } })),
      summary: { mode: 'on', reused: 0, asked: rows.length, answered: rows.length, failed: 0, deferred: 0 },
    }
  }
  const summary = await runCampusEventsIngest({ client: supabase, fetchImpl, now: NOW, sleep: noSleep, log: quiet, classify })
  assert.equal(context.client, supabase)
  assert.ok(context.sourceFreeFood instanceof Set)
  assert.deepEqual([...context.sourceFreeFood].sort(), ['iu_events:2440319', 'purdue_events:54231361791375'])
  assert.equal(summary.classify.mode, 'on')
  assert.equal(summary.classify.answered, 17)
  assert.equal(summary.totals.freeFood, 17) // what was written, not what the rules planned
  assert.equal(upsertedRows(supabase).filter((row) => row.free_food).length, 17)
})

test('a dry run never calls the classifier, which would read the database', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  let called = false
  const classify = async (rows) => {
    called = true
    return rows
  }
  const summary = await runCampusEventsIngest({ dryRun: true, fetchImpl, now: NOW, sleep: noSleep, log: quiet, classify })
  assert.equal(called, false)
  assert.deepEqual(summary.classify, { skipped: 'dry run' })
  assert.ok(summary.rows.every((row) => !('classifier' in row)))
})

test('more rows than one batch holds go up in batches', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  const supabase = database()
  const many = async (rows) =>
    Array.from({ length: UPSERT_BATCH_SIZE + 3 }, (_, i) => ({ ...rows[i % rows.length], dedupe_key: `test:${i}` }))
  const summary = await runCampusEventsIngest({ client: supabase, fetchImpl, now: NOW, sleep: noSleep, log: quiet, classify: many })
  const sizes = supabase.queriesOf('campus_events').filter((q) => operation(q.chain) === 'upsert').map((q) => q.chain[0].args[0].length)
  assert.deepEqual(sizes, [UPSERT_BATCH_SIZE, 3])
  assert.equal(summary.upserted, UPSERT_BATCH_SIZE + 3)
})

// ── Downtown: White River State Park, behind CAMPUS_EVENTS_DOWNTOWN (#30) ────

const PARK_URL = 'https://whiteriverstatepark.org/wp-json/tribe/events/v1/events'
const parkCalls = (calls) => calls.filter((c) => new URL(c.url).hostname === 'whiteriverstatepark.org')
const upsertBatches = (supabase) =>
  supabase.queriesOf('campus_events').filter((q) => operation(q.chain) === 'upsert').map((q) => q.chain.find((c) => c.method === 'upsert').args[0])
const sweptKeys = (supabase) => sweeps(supabase).map((q) => q.chain.find((c) => c.method === 'eq').args[1])
// Postgres refusing a downtown row before README step 49, as PostgREST hands it on.
const STEP_49_MISSING = {
  code: '23514',
  message: 'new row for relation "campus_events" violates check constraint "campus_events_venue_kind_check"',
  details: 'Failing row contains (...).',
  hint: null,
}

test("the park's list is one page with no query string, which its robots.txt disallows", () => {
  assert.equal(tribePageUrl(sourceByKey('wrsp_events')), PARK_URL)
  assert.equal(MAX_PAGES.tribe, 1)
})

test("the park's listings are kept from today on the campus calendar to 60 days out", async () => {
  const source = sourceByKey('wrsp_events')
  const kept = WRSP.events.filter((raw) => inTribeWindow(raw, source, WRSP_NOW))
  assert.equal(kept.length, 19)
  // Over before today (Thursday's Book Fair and Twilight Tales), or starting after
  // December 23 (Kwanzaa, New Year's Eve, MLK Day and next year's games and concerts).
  assert.deepEqual(
    WRSP.events.filter((raw) => !kept.includes(raw)).map((raw) => raw.id),
    [6886, 2847, 5989, 5993, 4865, 2981, 6946, 6933],
  )
  const at = (start, end) => inTribeWindow({ start_date: start, end_date: end }, source, WRSP_NOW)
  assert.equal(at('2026-10-01 00:00:00', '2026-10-24 23:59:59'), true) // on since the 1st, ends today
  assert.equal(at('2026-12-23 19:00:00', '2026-12-23 21:00:00'), true)
  assert.equal(at('2026-12-24 10:00:00', '2026-12-24 12:00:00'), false)
  assert.equal(at('TBA', null), true) // left to the plan, which skips it
  // Today is the campus date: 9:30 PM on the 24th is the 25th in UTC.
  const apocalypseNow = WRSP.events.find((raw) => raw.id === 6909) // all day on the 24th
  assert.equal(inTribeWindow(apocalypseNow, source, new Date('2026-10-25T01:30:00.000Z')), true)
  assert.equal(inTribeWindow(apocalypseNow, source, new Date('2026-10-25T05:00:00.000Z')), false)

  const { fetchImpl, calls } = fakeFetch(() => json(WRSP))
  const result = await fetchSourceListings(source, { fetchImpl, now: WRSP_NOW, sleep: noSleep, log: quiet })
  assert.deepEqual(calls.map((c) => c.url), [PARK_URL])
  assert.equal(calls[0].headers['user-agent'], 'BoilerIndy campus app (+https://www.boilerindy.app)')
  assert.deepEqual(result, { listings: kept, pages: 1, complete: true, error: null })

  // A list that outgrows its one page reads as incomplete: page 2 would need `?page=`.
  const longer = fakeFetch(() => json({ ...WRSP, total_pages: 2 }))
  const cut = await fetchSourceListings(source, { fetchImpl: longer.fetchImpl, now: WRSP_NOW, sleep: noSleep, log: quiet })
  assert.equal(longer.calls.length, 1)
  assert.deepEqual([cut.complete, cut.error, cut.listings.length], [false, 'wrsp_events has more than 1 page', 19])
})

test('with CAMPUS_EVENTS_DOWNTOWN off the park is never fetched, and the run and its summary are what they were', async () => {
  const { fetchImpl, calls } = fakeFetch(bySource())
  const supabase = database()
  const summary = await runCampusEventsIngest({ client: supabase, fetchImpl, now: WRSP_NOW, sleep: noSleep, log: quiet })
  assert.deepEqual(parkCalls(calls), [])
  assert.deepEqual(summary.sources.map((s) => s.key), ['purdue_events', 'iu_events', 'boilerlink', 'thespot'])
  assert.deepEqual(upsertBatches(supabase).map((batch) => batch.length), [17])
  assert.equal(summary.upserted, 17)
  assert.deepEqual(sweptKeys(supabase), ['purdue_events', 'iu_events'])
  const dry = await runCampusEventsIngest({ dryRun: true, downtownEnabled: false, fetchImpl, now: WRSP_NOW, sleep: noSleep, log: quiet })
  assert.equal(dry.rows.length, 17)
  assert.ok(dry.rows.every((row) => row.source_key !== 'wrsp_events'))
})

test('with it on, a dry run reads the park once and plans its listings as downtown rows, with no database', async () => {
  const { fetchImpl, calls } = fakeFetch(bySource())
  const summary = await runCampusEventsIngest({ dryRun: true, downtownEnabled: true, fetchImpl, now: WRSP_NOW, sleep: noSleep, log: quiet })
  assert.deepEqual(parkCalls(calls).map((c) => c.url), [PARK_URL])
  assert.deepEqual(summary.sources.map((s) => s.key), ['purdue_events', 'iu_events', 'boilerlink', 'thespot', 'wrsp_events'])
  assert.deepEqual(summary.sources.at(-1), {
    key: 'wrsp_events', enabled: true, ok: true, complete: true, pages: 1, error: null,
    listings: 19, skipped: 0, keptBy: { place: 18, scope: 1 }, droppedBy: {}, merged: 0, rows: 19,
  })
  const park = summary.rows.filter((row) => row.source_key === 'wrsp_events')
  assert.equal(park.length, 19)
  assert.ok(park.every((row) => row.venue_kind === 'downtown' && row.free_food === false))
  assert.equal(summary.rows.length, 17 + 19)
  assert.equal(summary.totals.venueKinds.downtown, 19)
})

test('with it on and README step 49 run, one downtown row goes up first, then every row, and the park is swept', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  const supabase = database()
  const warnings = []
  const log = { ...quiet, warn: (line) => warnings.push(line) }
  const summary = await runCampusEventsIngest({ client: supabase, downtownEnabled: true, fetchImpl, now: WRSP_NOW, sleep: noSleep, log })
  const batches = upsertBatches(supabase)
  assert.deepEqual(batches.map((batch) => batch.length), [1, 36])
  assert.deepEqual(batches[0].map((row) => [row.dedupe_key, row.venue_kind, row.last_seen_at]), [['wrsp_events:6909', 'downtown', WRSP_NOW.toISOString()]])
  assert.equal(batches[1].filter((row) => row.source_key === 'wrsp_events').length, 19)
  assert.equal(summary.upserted, 36)
  assert.deepEqual(sweptKeys(supabase), ['purdue_events', 'iu_events', 'wrsp_events'])
  assert.equal(summary.sources.at(-1).swept, 2)
  assert.deepEqual(warnings, [])
})

test('before README step 49 a run leaves the park out with one log line, and writes and sweeps the rest as before', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  const supabase = database({
    upsert: (chain) => {
      const batch = chain.find((c) => c.method === 'upsert').args[0]
      return batch.some((row) => row.venue_kind === 'downtown') ? { data: null, error: STEP_49_MISSING, status: 400 } : { error: null }
    },
  })
  const warnings = []
  const log = { ...quiet, warn: (line) => warnings.push(line) }
  const summary = await runCampusEventsIngest({ client: supabase, downtownEnabled: true, fetchImpl, now: WRSP_NOW, sleep: noSleep, log })
  assert.equal(summary.ok, true)
  // The one row it tried alone, then the campus rows by themselves.
  const batches = upsertBatches(supabase)
  assert.deepEqual(batches.map((batch) => batch.length), [1, 17])
  assert.ok(batches[1].every((row) => row.source_key !== 'wrsp_events'))
  assert.equal(summary.upserted, 17)
  assert.equal(summary.totals.rows, 17)
  assert.equal(summary.totals.venueKinds.downtown, undefined)
  // Its entry says why, and a source that was left out is not swept.
  const park = summary.sources.at(-1)
  assert.deepEqual([park.key, park.ok, park.schemaMissing, park.rows, park.swept], ['wrsp_events', false, DOWNTOWN_SQL_FILE, 19, undefined])
  assert.equal(park.error, "left out: campus_events does not allow venue_kind 'downtown' until db/supabase-campus-events-downtown.sql (README step 49) has run")
  assert.deepEqual(sweptKeys(supabase), ['purdue_events', 'iu_events'])
  assert.deepEqual(warnings, [
    "[campus-events] wrsp_events left out: campus_events does not allow venue_kind 'downtown' until db/supabase-campus-events-downtown.sql (README step 49) has run: run it in the Supabase SQL Editor.",
  ])

  // Any other refusal of that first row fails the run, as a failed write always has.
  const otherCheck = { ...STEP_49_MISSING, message: 'new row for relation "campus_events" violates check constraint "campus_events_category_check"' }
  const refusing = database({ upsert: () => ({ data: null, error: otherCheck, status: 400 }) })
  await assert.rejects(runCampusEventsIngest({ client: refusing, downtownEnabled: true, fetchImpl, now: WRSP_NOW, sleep: noSleep, log: quiet }), { code: '23514' })
  assert.equal(sweeps(refusing).length, 0)
})

test('isDowntownCheckViolation names only the venue_kind CHECK', () => {
  assert.equal(isDowntownCheckViolation(STEP_49_MISSING), true)
  // As upsertRows rethrows it (queryError), with the query named and the status after.
  assert.equal(isDowntownCheckViolation({ code: '23514', message: `campus_events upsert: ${STEP_49_MISSING.message} (HTTP 400)` }), true)
  assert.equal(isDowntownCheckViolation({ ...STEP_49_MISSING, code: '23505' }), false)
  assert.equal(isDowntownCheckViolation({ code: '23514', message: 'violates check constraint "campus_events_category_check"' }), false)
  assert.equal(isDowntownCheckViolation({ code: '23514', message: 'violates check constraint "campus_events_venue_kind_check_old"' }), false)
  assert.equal(isDowntownCheckViolation(null), false)
})
