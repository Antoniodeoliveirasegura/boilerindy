// Background re-sync (issue #12): which sources are due, and how one cron tick
// runs them. The picker is pure; the runner is exercised with a fake Supabase
// query chain and a fake sync, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_BATCH,
  DEFAULT_ERROR_RETRY_MS,
  DEFAULT_PER_USER,
  DEFAULT_STALE_MS,
  pickSourcesToResync,
  runSourceResync,
} from '../src/sourceResync.mjs'

const NOW = new Date('2026-09-14T12:00:00.000Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString()

function row(overrides = {}) {
  return { id: 'src', status: 'ready', last_synced_at: hoursAgo(12), updated_at: hoursAgo(12), ...overrides }
}

// ── pickSourcesToResync ─────────────────────────────────────────────────────

test('picks ready sources that are stale or never synced, synced ones first, oldest first', () => {
  const rows = [
    row({ id: 'fresh', last_synced_at: hoursAgo(1) }),
    row({ id: 'old', last_synced_at: hoursAgo(30) }),
    row({ id: 'never', last_synced_at: null }),
    row({ id: 'stale', last_synced_at: hoursAgo(7) }),
  ]
  const picked = pickSourcesToResync(rows, { now: NOW }).map((r) => r.id)
  assert.deepEqual(picked, ['old', 'stale', 'never'])
})

test('the stale threshold is 6 hours by default and configurable', () => {
  assert.equal(DEFAULT_STALE_MS, 6 * 60 * 60 * 1000)
  const rows = [row({ id: 'five', last_synced_at: hoursAgo(5) }), row({ id: 'seven', last_synced_at: hoursAgo(7) })]
  assert.deepEqual(pickSourcesToResync(rows, { now: NOW }).map((r) => r.id), ['seven'])
  // Both due under a one-hour threshold; the older sync still goes first.
  assert.deepEqual(pickSourcesToResync(rows, { now: NOW, staleMs: 60 * 60 * 1000 }).map((r) => r.id), ['seven', 'five'])
})

test('retries error sources daily, based on the last attempt, not every tick', () => {
  assert.equal(DEFAULT_ERROR_RETRY_MS, 24 * 60 * 60 * 1000)
  const rows = [
    row({ id: 'just-failed', status: 'error', last_synced_at: hoursAgo(50), updated_at: hoursAgo(1) }),
    row({ id: 'failed-yesterday', status: 'error', last_synced_at: hoursAgo(50), updated_at: hoursAgo(25) }),
    row({ id: 'bad-from-start', status: 'error', last_synced_at: null, updated_at: hoursAgo(30) }),
  ]
  const picked = pickSourcesToResync(rows, { now: NOW }).map((r) => r.id)
  assert.deepEqual(picked, ['failed-yesterday', 'bad-from-start'])
})

test('sources that have synced go before those that never have, which take turns by their last attempt', () => {
  const rows = [
    row({ id: 'never-tried-26h-ago', status: 'error', last_synced_at: null, updated_at: hoursAgo(26), user_id: 'u1' }),
    row({ id: 'never-tried-50h-ago', status: 'error', last_synced_at: null, updated_at: hoursAgo(50), user_id: 'u2' }),
    row({ id: 'pending-30h', status: 'pending', last_synced_at: null, updated_at: hoursAgo(30), user_id: 'u3' }),
    row({ id: 'stale', last_synced_at: hoursAgo(7), user_id: 'u4' }),
  ]
  assert.deepEqual(
    pickSourcesToResync(rows, { now: NOW }).map((r) => r.id),
    ['stale', 'never-tried-50h-ago', 'pending-30h', 'never-tried-26h-ago'],
  )
})

test('one account takes at most two places a tick, so its sources cannot crowd out other students', () => {
  assert.equal(DEFAULT_PER_USER, 2)
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => row({ id: `a${i}`, user_id: 'A', last_synced_at: hoursAgo(40 - i) })),
    row({ id: 'b', user_id: 'B', last_synced_at: hoursAgo(7) }),
    row({ id: 'c', user_id: 'C', last_synced_at: hoursAgo(8) }),
  ]
  assert.deepEqual(pickSourcesToResync(rows, { now: NOW }).map((r) => r.id), ['a0', 'a1', 'c', 'b'])
  assert.deepEqual(pickSourcesToResync(rows, { now: NOW, perUser: 1 }).map((r) => r.id), ['a0', 'c', 'b'])
  // A row listed without its user_id counts as an account of its own.
  const anonymous = Array.from({ length: 6 }, (_, i) => row({ id: `s${i}`, last_synced_at: hoursAgo(40 - i) }))
  assert.equal(pickSourcesToResync(anonymous, { now: NOW, perUser: 1 }).length, 4)
})

test('pending sources count as never synced; unknown statuses are skipped', () => {
  const rows = [
    row({ id: 'pending', status: 'pending', last_synced_at: null }),
    row({ id: 'weird', status: 'syncing', last_synced_at: null }),
    row({ id: 'disabled', status: 'disabled', last_synced_at: null }),
    null,
  ]
  assert.deepEqual(pickSourcesToResync(rows, { now: NOW }).map((r) => r.id), ['pending'])
})

test('caps a tick at the batch size', () => {
  // Four since 2026-11-03, so the feeds that come due together spread over runs.
  assert.equal(DEFAULT_BATCH, 4)
  const rows = Array.from({ length: 40 }, (_, i) => row({ id: `s${i}`, last_synced_at: hoursAgo(100 - i) }))
  const picked = pickSourcesToResync(rows, { now: NOW })
  assert.equal(picked.length, 4)
  assert.equal(picked[0].id, 's0') // the oldest sync goes first
  assert.equal(pickSourcesToResync(rows, { now: NOW, batch: 3 }).length, 3)
})

// ── runSourceResync ─────────────────────────────────────────────────────────

// A fake Supabase client over `rows` that applies what a listing asks for:
// the in, is and not filters, the order (nulls last unless nullsFirst, as
// Postgres sorts ascending) and the limit. Each query's calls are recorded,
// and rows come back as copies, as rows read from a database do.
function fakeClient(rows, error = null, status = error ? 500 : 200) {
  const queries = []
  const matches = (filters) => (row) =>
    filters.every(([method, col, ...args]) => {
      if (method === 'in') return args[0].includes(row[col])
      if (method === 'is' && args[0] === null) return row[col] == null
      if (method === 'not' && args[0] === 'is' && args[1] === null) return row[col] != null
      throw new Error(`fakeClient: no support for ${method} ${JSON.stringify(args)}`)
    })
  const client = {
    from: (table) => {
      const query = { table, filters: [] }
      queries.push(query)
      const chain = {
        select: (cols) => { query.select = cols; return chain },
        in: (col, values) => { query.filters.push(['in', col, values]); return chain },
        is: (col, value) => { query.filters.push(['is', col, value]); return chain },
        not: (col, op, value) => { query.filters.push(['not', col, op, value]); return chain },
        order: (col, opts) => { query.order = [col, opts]; return chain },
        limit: (n) => {
          query.limit = n
          if (error) return Promise.resolve({ data: null, error, status })
          let found = (rows || []).filter(matches(query.filters))
          if (query.order) {
            const [col, { ascending = true, nullsFirst = !ascending } = {}] = query.order
            const rank = (row) => (row[col] == null ? (nullsFirst ? -Infinity : Infinity) : Date.parse(row[col]))
            found = found.sort((a, b) => (rank(a) === rank(b) ? 0 : (rank(a) < rank(b)) === ascending ? -1 : 1))
          }
          return Promise.resolve({ data: found.slice(0, n).map((r) => ({ ...r })), error: null, status })
        },
      }
      return chain
    },
  }
  return { client, queries }
}

test('runSourceResync lists candidates, syncs the due ones in order, and reports', async () => {
  const rows = [
    row({ id: 'fresh', last_synced_at: hoursAgo(1) }),
    row({ id: 'never', last_synced_at: null, user_id: 'u1', source_url: 'https://x/feed.ics' }),
    row({ id: 'old', last_synced_at: hoursAgo(20), user_id: 'u2', source_url: 'https://y/feed.ics' }),
    row({ id: 'broken', last_synced_at: hoursAgo(20), user_id: 'u3', source_url: 'https://z/feed.ics' }),
  ]
  const { client, queries } = fakeClient(rows)
  const synced = []
  const sync = async (source) => {
    synced.push(source.id)
    if (source.id === 'broken') throw new Error('Calendar access denied. The feed URL may have expired - try generating a new one.')
    return { itemCount: source.id === 'never' ? 12 : 3 }
  }

  const summary = await runSourceResync({ client, sync, now: NOW })

  // Two listings, one after the other: sources that have synced, oldest sync
  // first, then sources that never have, oldest attempt first.
  assert.deepEqual(
    queries.map((q) => [q.table, q.filters, q.order, q.limit]),
    [
      ['linked_sources', [['in', 'status', ['ready', 'error', 'pending']], ['not', 'last_synced_at', 'is', null]], ['last_synced_at', { ascending: true }], 200],
      ['linked_sources', [['in', 'status', ['ready', 'error', 'pending']], ['is', 'last_synced_at', null]], ['updated_at', { ascending: true }], 200],
    ],
  )

  assert.deepEqual(synced, ['old', 'broken', 'never'])
  assert.equal(summary.ok, true)
  assert.equal(summary.scanned, 4)
  assert.equal(summary.due, 3)
  assert.equal(summary.synced, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.deferred, 0)
  assert.equal(summary.items, 15)
  assert.deepEqual(summary.failures, [{ id: 'broken', message: 'Calendar access denied. The feed URL may have expired - try generating a new one.' }])
  assert.equal(summary.truncated, false)
  assert.ok(summary.durationMs >= 0)
})

test('runSourceResync stops starting syncs once the time budget is spent', async () => {
  const rows = [row({ id: 'a', last_synced_at: null }), row({ id: 'b', last_synced_at: null }), row({ id: 'c', last_synced_at: null })]
  const { client } = fakeClient(rows)
  const synced = []
  const sync = async (source) => {
    synced.push(source.id)
    await new Promise((r) => setTimeout(r, 15))
    return { itemCount: 1 }
  }
  const summary = await runSourceResync({ client, sync, now: NOW, budgetMs: 5 })
  assert.deepEqual(synced, ['a']) // the first always runs; the budget check is before each start
  assert.equal(summary.synced, 1)
  assert.equal(summary.deferred, 2)
})

test('runSourceResync surfaces a listing failure instead of reporting success', async () => {
  const { client } = fakeClient(null, { message: 'relation "linked_sources" does not exist' })
  await assert.rejects(() => runSourceResync({ client, sync: async () => ({}) }), /Could not list linked sources/)

  // A gateway timeout keeps its status, so the route's one retry can recognise it (issue #242).
  const gateway = fakeClient(null, { message: 'Gateway Timeout' }, 504)
  await assert.rejects(
    () => runSourceResync({ client: gateway.client, sync: async () => ({}) }),
    (err) => err.name === 'SupabaseQueryError' && err.status === 504 && err.message === 'Could not list linked sources: Gateway Timeout (HTTP 504)',
  )
  // The first listing failing ends the tick before the second is read.
  assert.equal(gateway.queries.length, 1)
})

test("200 sources of one account that never sync no longer keep another student's feed from re-syncing", async () => {
  // One account's links that fail their first sync, as a script could add
  // them, and one other student's working feed. With a single window ordered
  // never-synced first, the 200 filled it, 'b' was never listed, and after a
  // day every tick went to retrying them.
  const rows = [
    ...Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, user_id: 'A', status: 'error', last_synced_at: null, updated_at: hoursAgo(25) })),
    { id: 'b', user_id: 'B', status: 'ready', last_synced_at: hoursAgo(7), updated_at: hoursAgo(7) },
  ]
  const { client } = fakeClient(rows)
  let now = NOW
  const bSyncs = []
  // As runScheduleSync does: a failure moves updated_at only, a success both.
  const sync = async (source) => {
    const stored = rows.find((r) => r.id === source.id)
    stored.updated_at = now.toISOString()
    if (stored.user_id === 'A') throw new Error('Could not reach the calendar URL. Please check the URL is correct and accessible.')
    stored.last_synced_at = now.toISOString()
    bSyncs.push(now.toISOString())
    return { itemCount: 1 }
  }
  const summaries = []
  for (let tick = 0; tick < 48; tick += 1) {
    summaries.push(await runSourceResync({ client, sync, now }))
    now = new Date(now.getTime() + 60 * 60 * 1000)
  }
  // 'b' syncs on the first tick and every 6 hours after: ticks 0, 6, ... 42.
  assert.equal(bSyncs.length, 8)
  assert.equal(bSyncs[0], NOW.toISOString())
  // A's retries still run, two places a tick at most.
  assert.ok(summaries.every((s) => s.failed <= 2))
  assert.equal(summaries.reduce((sum, s) => sum + s.failed, 0), 96)
  assert.equal(summaries[0].truncated, true)
})

test('a source that both listings return is synced once', async () => {
  // It synced between the two reads, so it is in both.
  const both = row({ id: 'both', user_id: 'u1', last_synced_at: hoursAgo(10) })
  let reads = 0
  const chain = {
    select: () => chain,
    in: () => chain,
    is: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => {
      reads += 1
      return Promise.resolve({ data: [{ ...both }], error: null, status: 200 })
    },
  }
  const synced = []
  const summary = await runSourceResync({
    client: { from: () => chain },
    sync: async (source) => {
      synced.push(source.id)
      return { itemCount: 0 }
    },
    now: NOW,
  })
  assert.equal(reads, 2)
  assert.deepEqual(synced, ['both'])
  assert.equal(summary.scanned, 1)
})
