// Tests for the shared campus events ingest shell (issue #30): page URLs,
// paging, the one retry, the dry run, the upsert and the per-source sweep.
// Nothing leaves the machine: fetch is a fake that answers each source's host
// with the 2026-10-17 fixtures (see test/sharedEvents.test.mjs), and the
// database is the recording fake the router tests use.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  MAX_PAGES,
  PAGE_DELAY_MS,
  UPSERT_BATCH_SIZE,
  campusYmd,
  engagePageUrl,
  fetchSourceListings,
  liveWhalePageUrl,
  localistPageUrl,
  runCampusEventsIngest,
} from '../src/campusEventsIngest.mjs'
import { sourceByKey } from '../src/sharedEvents.mjs'
import { fakeSupabase, hasCall, operation } from './routes/fakeSupabase.mjs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const LOCALIST = fixture('campus-events-localist.json')
const LIVEWHALE = fixture('campus-events-livewhale.json')
const BOILERLINK = fixture('campus-events-boilerlink.json')
const THESPOT = fixture('campus-events-thespot.json')

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
    { key: 'iu_events', enabled: true, ok: true, complete: true, rows: 10 },
    { key: 'boilerlink', enabled: false, ok: undefined, complete: undefined, rows: undefined },
    { key: 'thespot', enabled: false, ok: undefined, complete: undefined, rows: undefined },
  ])
  assert.equal(summary.rows.length, 19)
  assert.equal(summary.totals.rows, 19)
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
  assert.equal(rows.length, 19)
  assert.ok(rows.every((row) => row.last_seen_at === RUN_AT && !('classifier' in row)))
  assert.equal(summary.upserted, 19)
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
  assert.equal(summary.rows.length, 33)
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
  assert.equal(summary.upserted, 19)
  assert.match(summary.sources[0].sweepError, /campus_events sweep: Gateway Timeout \(HTTP 504\)/)
  assert.equal(errors.length, 2)
})

test('an upsert that fails transiently is retried once; a second failure, or a missing table, rejects', async () => {
  const { fetchImpl } = fakeFetch(bySource())
  let attempts = 0
  const flaky = database({ upsert: () => (++attempts === 1 ? { data: null, error: { message: 'Gateway Timeout' }, status: 504 } : { error: null }) })
  const summary = await runCampusEventsIngest({ client: flaky, fetchImpl, now: NOW, sleep: noSleep, log: quiet })
  assert.equal(attempts, 2)
  assert.equal(summary.upserted, 19)

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
  assert.equal(seen.length, 19)
  const batches = supabase.queriesOf('campus_events').filter((q) => operation(q.chain) === 'upsert').map((q) => q.chain[0].args[0])
  assert.equal(batches.length, 2)
  assert.ok(batches[0].every((row) => !('classifier' in row)))
  assert.ok(batches[1].every((row) => row.classifier === verdict && row.free_food === true))
  assert.equal(batches[0].length + batches[1].length, 19)

  await assert.rejects(
    runCampusEventsIngest({ client: database(), fetchImpl, now: NOW, sleep: noSleep, log: quiet, classify: async () => undefined }),
    /classify must resolve with the rows/,
  )
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
