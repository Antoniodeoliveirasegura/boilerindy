import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCalendarItemStore, isUnchanged } from '../src/calendarItemStore.mjs'

// replaceItems used to delete every row for a source and then insert the new set.
// Any insert failure - most easily a collision on UNIQUE(source_id, external_uid),
// which planSync's title/date/hour/location dedupe does not prevent - left the
// user with an empty calendar, because the delete had already committed. These
// tests pin the write-first ordering and the collapse that makes it safe.
//
// It then re-wrote every row on every background re-sync, which was most of the
// project's disk IO. The store now reads the source's rows, writes only new or
// changed ones, and deletes by id what the feed stopped listing.

function makeSupabase({ stored = [], readError = null, upsertError = null, sweepError = null } = {}) {
  const calls = []
  const supabase = {
    from(table) {
      return {
        select(columns) {
          const filters = {}
          const builder = {
            eq(column, value) {
              filters[column] = value
              return builder
            },
            order() {
              return builder
            },
            range(from, to) {
              calls.push({ op: 'select', table, columns, filters, from, to })
              if (readError) return Promise.resolve({ data: null, error: readError })
              return Promise.resolve({ data: stored.slice(from, to + 1), error: null })
            },
          }
          return builder
        },
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
            in(column, values) {
              filters[`${column}__in`] = values
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
    description: null,
    start_time: '2026-07-05T14:30:00.000Z',
    end_time: '2026-07-05T15:45:00.000Z',
    location: 'ET 215',
    category: 'class',
    external_uid: externalUid,
    all_day: false,
    raw_json: { uid: externalUid, summary: 'CS 250 Lecture', description: null, location: 'ET 215' },
    ...overrides,
  }
}

// What PostgREST hands back for a row written from row(): its own id, the
// timestamps in +00:00 form and the jsonb keys in Postgres order.
function storedRow(id, externalUid, overrides = {}) {
  const sent = row(externalUid)
  return {
    id,
    external_uid: externalUid,
    user_id: sent.user_id,
    source_type: sent.source_type,
    title: sent.title,
    description: sent.description,
    start_time: '2026-07-05T14:30:00+00:00',
    end_time: '2026-07-05T15:45:00+00:00',
    location: sent.location,
    category: sent.category,
    all_day: sent.all_day,
    raw_json: { uid: externalUid, summary: sent.title, location: sent.location, description: null },
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

test('reads the source, then writes, then deletes what the feed dropped', async () => {
  const { supabase, calls } = makeSupabase({ stored: [storedRow('id-old', 'uid-old')] })
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [row('uid-1')])

  assert.deepEqual(calls.map((c) => c.op), ['select', 'upsert', 'delete'])
  assert.equal(calls[0].filters.source_id, 'src-1')
})

test('an unchanged row is not written again, and nothing is deleted', async () => {
  const { supabase, calls } = makeSupabase({ stored: [storedRow('id-1', 'uid-1'), storedRow('id-2', 'uid-2')] })
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [row('uid-1'), row('uid-2')])

  assert.deepEqual(calls.map((c) => c.op), ['select'])
})

test('only new and changed rows are written', async () => {
  const { supabase, calls } = makeSupabase({ stored: [storedRow('id-1', 'uid-1'), storedRow('id-2', 'uid-2')] })
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [
    row('uid-1'),
    row('uid-2', { location: 'SL 008' }),
    row('uid-3'),
  ])

  const [upsert] = calls.filter((c) => c.op === 'upsert')
  assert.deepEqual(upsert.rows.map((r) => r.external_uid).sort(), ['uid-2', 'uid-3'])
  assert.equal(calls.some((c) => c.op === 'delete'), false)
})

test('every column planSync writes counts as a change', () => {
  const stored = storedRow('id-1', 'uid-1')
  assert.equal(isUnchanged(stored, row('uid-1')), true)
  const changes = {
    user_id: 'user-2',
    source_type: 'purdue_ical',
    title: 'CS 250 Lab',
    description: 'Bring a laptop',
    start_time: '2026-07-05T14:31:00.000Z',
    end_time: null,
    location: null,
    category: 'deadline',
    all_day: true,
    raw_json: { uid: 'uid-1', summary: 'CS 250 Lab', description: null, location: 'ET 215' },
  }
  for (const [column, value] of Object.entries(changes)) {
    assert.equal(isUnchanged(stored, row('uid-1', { [column]: value })), false, `${column} change must be written`)
  }
})

test('a failed write throws and deletes nothing', async () => {
  const { supabase, calls } = makeSupabase({ stored: [storedRow('id-old', 'uid-old')], upsertError: { message: 'boom' } })
  const store = createCalendarItemStore(supabase)

  await assert.rejects(() => store.replaceItems('src-1', [row('uid-1')]), /boom/)

  // The wipe this whole change exists to prevent.
  assert.equal(calls.some((c) => c.op === 'delete'), false)
})

test('never sends identity columns, so re-synced rows keep their id', async () => {
  const { supabase, calls } = makeSupabase({ stored: [storedRow('id-1', 'uid-1', { title: 'Old title' })] })
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [row('uid-1')])

  // A fresh id per sync would cascade-delete user_task_completions rows that
  // reference calendar_items(id), silently unticking every completed task.
  const written = calls.find((c) => c.op === 'upsert').rows[0]
  for (const column of ['id', 'created_at', 'updated_at']) {
    assert.equal(column in written, false, `${column} must be left to the database`)
  }
  assert.equal(calls.some((c) => c.op === 'delete'), false)
})

test('deletes only the stored rows the feed no longer lists, by id, within the source', async () => {
  const { supabase, calls } = makeSupabase({ stored: [storedRow('id-1', 'uid-1'), storedRow('id-2', 'uid-2'), storedRow('id-3', 'uid-3')] })
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [row('uid-2')])

  const deletes = calls.filter((c) => c.op === 'delete')
  assert.equal(deletes.length, 1)
  assert.equal(deletes[0].filters.source_id, 'src-1')
  assert.deepEqual(deletes[0].filters.id__in, ['id-1', 'id-3'])
  assert.equal('updated_at__lt' in deletes[0].filters, false)
})

test('deletes in batches of 100 ids', async () => {
  const stored = Array.from({ length: 250 }, (_, i) => storedRow(`id-${i}`, `uid-${i}`))
  const { supabase, calls } = makeSupabase({ stored })
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [])

  const deletes = calls.filter((c) => c.op === 'delete')
  assert.deepEqual(deletes.map((d) => d.filters.id__in.length), [100, 100, 50])
  assert.equal(new Set(deletes.flatMap((d) => d.filters.id__in)).size, 250)
})

test('reads every page of a large source before comparing', async () => {
  const stored = Array.from({ length: 2500 }, (_, i) => storedRow(`id-${i}`, `uid-${i}`))
  const { supabase, calls } = makeSupabase({ stored })
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', stored.map((s) => row(s.external_uid)))

  assert.equal(calls.filter((c) => c.op === 'select').length, 3)
  assert.deepEqual(calls.map((c) => c.op), ['select', 'select', 'select'])
})

test('sweeps the source when the feed comes back empty', async () => {
  const { supabase, calls } = makeSupabase({ stored: [storedRow('id-1', 'uid-1')] })
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [])

  assert.equal(calls.some((c) => c.op === 'upsert'), false)
  const sweep = calls.find((c) => c.op === 'delete')
  assert.equal(sweep.filters.source_id, 'src-1')
  assert.deepEqual(sweep.filters.id__in, ['id-1'])
})

test('when the stored rows cannot be read, it writes every row and sweeps by updated_at', async () => {
  const { supabase, calls } = makeSupabase({ readError: { message: 'read failed' } })
  const store = createCalendarItemStore(supabase)

  await store.replaceItems('src-1', [row('uid-1'), row('uid-2')])

  assert.deepEqual(calls.map((c) => c.op), ['select', 'upsert', 'delete'])
  assert.equal(calls[1].rows.length, 2)
  assert.equal(calls[2].filters.source_id, 'src-1')
  assert.equal(typeof calls[2].filters.updated_at__lt, 'string')
})

test('the fallback sweep threshold trails now, absorbing clock skew', async () => {
  const { supabase, calls } = makeSupabase({ readError: { message: 'read failed' } })
  const store = createCalendarItemStore(supabase)

  const before = Date.now()
  await store.replaceItems('src-1', [row('uid-1')])

  const threshold = Date.parse(calls.find((c) => c.op === 'delete').filters.updated_at__lt)
  assert.ok(threshold < before, 'threshold must be in the past')
  assert.ok(before - threshold >= 60_000, 'guard band should be at least a minute')
})
