import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CALENDAR_CATEGORY_LABELS,
  categoryListFromCounts,
  loadCalendarCategoryCounts,
} from '../src/calendarCategoryCounts.mjs'

// Issue #198: /api/me/calendar/categories selected every calendar row for the
// user and counted in JS, which PostgREST's 1000-row cap silently truncated.
// The count now comes from the calendar_category_counts RPC, with the old JS
// count as the fallback until db/supabase-calendar-category-counts.sql runs.

// 1200 rows: 900 classes across three terms plus assignments, exams and events.
function calendarRows(userId = 'u1') {
  const rows = []
  const add = (category, count) => {
    for (let i = 0; i < count; i += 1) rows.push({ user_id: userId, category })
  }
  add('class', 900)
  add('assignment', 180)
  add('exam', 45)
  add('campus_event', 75)
  return rows
}

// Models the Postgres function: GROUP BY category for one user, bigint counts.
function groupedCounts(rows, userId) {
  const byCategory = new Map()
  for (const row of rows) {
    if (row.user_id !== userId) continue
    byCategory.set(row.category, (byCategory.get(row.category) || 0) + 1)
  }
  return [...byCategory].map(([category, itemCount]) => ({ category, item_count: itemCount }))
}

function makeSupabase({ rows = [], rpcError = null, selectError = null, maxRows = 1000 } = {}) {
  const calls = []
  return {
    calls,
    rpc(name, args) {
      calls.push({ op: 'rpc', name, args })
      if (rpcError) return Promise.resolve({ data: null, error: rpcError })
      return Promise.resolve({ data: groupedCounts(rows, args.p_user_id), error: null })
    },
    from(table) {
      return {
        select(columns) {
          return {
            eq(column, value) {
              calls.push({ op: 'select', table, columns, column, value })
              if (selectError) return Promise.resolve({ data: null, error: selectError })
              const data = rows.filter((row) => row[column] === value).slice(0, maxRows)
              return Promise.resolve({ data: data.map((row) => ({ category: row.category })), error: null })
            },
          }
        },
      }
    },
  }
}

test('1200 rows: counts from the RPC match the rows, with no row read', async () => {
  const rows = [...calendarRows('u1'), ...calendarRows('u2')]
  const supabase = makeSupabase({ rows })

  const { counts, error } = await loadCalendarCategoryCounts(supabase, 'u1')

  assert.equal(error, undefined)
  assert.deepEqual(counts, { class: 900, assignment: 180, exam: 45, campus_event: 75 })
  assert.deepEqual(supabase.calls, [{ op: 'rpc', name: 'calendar_category_counts', args: { p_user_id: 'u1' } }])
})

test('RPC counts arriving as strings are coerced to numbers', async () => {
  const supabase = {
    rpc: () => Promise.resolve({ data: [{ category: 'class', item_count: '1200' }], error: null }),
  }
  const { counts } = await loadCalendarCategoryCounts(supabase, 'u1')
  assert.deepEqual(counts, { class: 1200 })
})

test('falls back to counting rows when the function is not installed yet', async () => {
  const rows = [
    { user_id: 'u1', category: 'class' },
    { user_id: 'u1', category: 'class' },
    { user_id: 'u1', category: 'exam' },
    { user_id: 'u2', category: 'class' },
  ]
  const supabase = makeSupabase({ rows, rpcError: { code: 'PGRST202', message: 'Could not find the function' } })

  const { counts, error } = await loadCalendarCategoryCounts(supabase, 'u1')

  assert.equal(error, undefined)
  assert.deepEqual(counts, { class: 2, exam: 1 })
  assert.deepEqual(
    supabase.calls.map((call) => call.op),
    ['rpc', 'select'],
  )
  assert.equal(supabase.calls[1].table, 'calendar_items')
  assert.equal(supabase.calls[1].columns, 'category')
})

test('any other RPC error is returned without a fallback read', async () => {
  const rpcError = { code: '57014', message: 'canceling statement due to statement timeout' }
  const supabase = makeSupabase({ rows: calendarRows(), rpcError })

  const { counts, error } = await loadCalendarCategoryCounts(supabase, 'u1')

  assert.deepEqual(counts, {})
  assert.equal(error, rpcError)
  assert.equal(supabase.calls.length, 1)
})

test('a failed fallback read returns its error', async () => {
  const selectError = { message: 'network down' }
  const supabase = makeSupabase({ rpcError: { code: '42883' }, selectError })

  const { counts, error } = await loadCalendarCategoryCounts(supabase, 'u1')

  assert.deepEqual(counts, {})
  assert.equal(error, selectError)
})

test('categoryListFromCounts labels known categories and sorts by count', () => {
  assert.deepEqual(categoryListFromCounts({ exam: 45, class: 900, assignment: 180, custom_thing: 3 }), [
    { id: 'class', label: 'Classes', count: 900 },
    { id: 'assignment', label: 'Assignments', count: 180 },
    { id: 'exam', label: 'Exams', count: 45 },
    { id: 'custom_thing', label: 'custom_thing', count: 3 },
  ])
  assert.deepEqual(categoryListFromCounts({}), [])
  assert.equal(CALENDAR_CATEGORY_LABELS.event, 'Other Events')
})
