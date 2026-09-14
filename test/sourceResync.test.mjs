// Background re-sync (issue #12): which sources are due, and how one cron tick
// runs them. The picker is pure; the runner is exercised with a fake Supabase
// query chain and a fake sync, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_BATCH,
  DEFAULT_ERROR_RETRY_MS,
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

test('picks ready sources that are stale or never synced, oldest first', () => {
  const rows = [
    row({ id: 'fresh', last_synced_at: hoursAgo(1) }),
    row({ id: 'old', last_synced_at: hoursAgo(30) }),
    row({ id: 'never', last_synced_at: null }),
    row({ id: 'stale', last_synced_at: hoursAgo(7) }),
  ]
  const picked = pickSourcesToResync(rows, { now: NOW }).map((r) => r.id)
  assert.deepEqual(picked, ['never', 'old', 'stale'])
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
  assert.deepEqual(picked, ['bad-from-start', 'failed-yesterday'])
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
  assert.equal(DEFAULT_BATCH, 15)
  const rows = Array.from({ length: 40 }, (_, i) => row({ id: `s${i}`, last_synced_at: hoursAgo(100 - i) }))
  const picked = pickSourcesToResync(rows, { now: NOW })
  assert.equal(picked.length, 15)
  assert.equal(picked[0].id, 's0') // the oldest sync goes first
  assert.equal(pickSourcesToResync(rows, { now: NOW, batch: 3 }).length, 3)
})

// ── runSourceResync ─────────────────────────────────────────────────────────

function fakeClient(rows, error = null) {
  const calls = {}
  const chain = {
    select: (cols) => { calls.select = cols; return chain },
    in: (col, values) => { calls.in = [col, values]; return chain },
    order: (col, opts) => { calls.order = [col, opts]; return chain },
    limit: (n) => { calls.limit = n; return Promise.resolve({ data: rows, error }) },
  }
  return { client: { from: (table) => { calls.from = table; return chain } }, calls }
}

test('runSourceResync lists candidates, syncs the due ones in order, and reports', async () => {
  const rows = [
    row({ id: 'fresh', last_synced_at: hoursAgo(1) }),
    row({ id: 'never', last_synced_at: null, user_id: 'u1', source_url: 'https://x/feed.ics' }),
    row({ id: 'old', last_synced_at: hoursAgo(20), user_id: 'u2', source_url: 'https://y/feed.ics' }),
    row({ id: 'broken', last_synced_at: hoursAgo(20), user_id: 'u3', source_url: 'https://z/feed.ics' }),
  ]
  const { client, calls } = fakeClient(rows)
  const synced = []
  const sync = async (source) => {
    synced.push(source.id)
    if (source.id === 'broken') throw new Error('Calendar access denied. The feed URL may have expired - try generating a new one.')
    return { itemCount: source.id === 'never' ? 12 : 3 }
  }

  const summary = await runSourceResync({ client, sync, now: NOW })

  assert.equal(calls.from, 'linked_sources')
  assert.deepEqual(calls.in, ['status', ['ready', 'error', 'pending']])
  assert.deepEqual(calls.order, ['last_synced_at', { ascending: true, nullsFirst: true }])
  assert.equal(calls.limit, 200)

  assert.deepEqual(synced, ['never', 'old', 'broken'])
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
})
