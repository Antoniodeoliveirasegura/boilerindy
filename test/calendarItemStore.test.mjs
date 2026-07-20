import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCalendarItemStore } from '../src/calendarItemStore.mjs'

// replaceItems used to delete every row for a source and then insert the new set.
// Any insert failure - most easily a collision on UNIQUE(source_id, external_uid),
// which planSync's title/date/hour/location dedupe does not prevent - left the
// user with an empty calendar, because the delete had already committed. These
// tests pin the write-first ordering and the collapse that makes it safe.

function makeSupabase({ upsertError = null, sweepError = null } = {}) {
  const calls = []
  const supabase = {
    from(table) {
      return {
        upsert(rows, opts) {
          calls.push({ op: 'upsert', table, rows, opts })
          return Promise.resolve({ error: upsertError })
        },
        delete() {
          const filters = {}
          const builder = {
            eq(column, value) {
              filters[column] = value
              return builder
            },
            lt(column, value) {
              filters[`${column}__lt`] = value
              return builder
            },
            then(resolve, reject) {
              calls.push({ op: 'delete', table, filters })
              return Promise.resolve({ error: sweepError }).then(resolve, reject)
            },
          }
          return builder
        },
      }
    },
  }
  return { supabase, calls }
}

function row(externalUid, overrides = {}) {
  return {
    user_id: 'user-1',
    source_id: 'src-1',
    source_type: 'brightspace_ical',
    title: 'CS 250 Lecture',
    start_time: '2026-07-05T14:30:00.000Z',
    category: 'class',
    external_uid: externalUid,
    ...overrides,
  }
}

test('collapses rows that collide on the table unique key', async () => {
  const { supabase, calls } = makeSupabase()
  const store = createCalendarItemStore(supabase)

  // Same UID, different hour: planSync's dedupe key includes the hour, so both
  // of these reach the store and would violate UNIQUE(source_id, external_uid).
  await store.replaceItems('src-1', [
    row('uid-1', { start_time: '2026-07-05T14:30:00.000Z' }),
    row('uid-1', { start_time: '2026-07-05T16:30:00.000Z' }),
    row('uid-2'),
  ])

  const upserts = calls.filter((c) => c.op === 'upsert')
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].rows.length, 2)
  assert.deepEqual(
    upserts[0].rows.map((r) => r.external_uid).sort(),
    ['uid-1', 'uid-2'],
  )
  assert.equal(upserts[0].opts.onConflict, 'source_id,external_uid')
})

test('writes before it sweeps', async () => {
  const { supabase, calls } = makeSupabase()
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [row('uid-1')])

  assert.deepEqual(calls.map((c) => c.op), ['upsert', 'delete'])
})

test('a failed write throws and deletes nothing', async () => {
  const { supabase, calls } = makeSupabase({ upsertError: { message: 'boom' } })
  const store = createCalendarItemStore(supabase)

  await assert.rejects(() => store.replaceItems('src-1', [row('uid-1')]), /boom/)

  // The wipe this whole change exists to prevent.
  assert.equal(calls.some((c) => c.op === 'delete'), false)
})

test('never sends identity columns, so re-synced rows keep their id', async () => {
  const { supabase, calls } = makeSupabase()
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [row('uid-1')])

  // A fresh id per sync would cascade-delete user_task_completions rows that
  // reference calendar_items(id), silently unticking every completed task.
  const written = calls.find((c) => c.op === 'upsert').rows[0]
  for (const column of ['id', 'created_at', 'updated_at']) {
    assert.equal(column in written, false, `${column} must be left to the database`)
  }
})

test('sweeps the source when the feed comes back empty', async () => {
  const { supabase, calls } = makeSupabase()
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [])

  assert.equal(calls.some((c) => c.op === 'upsert'), false)
  const sweep = calls.find((c) => c.op === 'delete')
  assert.equal(sweep.filters.source_id, 'src-1')
  assert.equal(typeof sweep.filters.updated_at__lt, 'string')
})

test('the sweep threshold trails now, absorbing clock skew', async () => {
  const { supabase, calls } = makeSupabase()
  const store = createCalendarItemStore(supabase)

  const before = Date.now()
  await store.replaceItems('src-1', [row('uid-1')])

  const threshold = Date.parse(calls.find((c) => c.op === 'delete').filters.updated_at__lt)
  assert.ok(threshold < before, 'threshold must be in the past')
  assert.ok(before - threshold >= 60_000, 'guard band should be at least a minute')
})
