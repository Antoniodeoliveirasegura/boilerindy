import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCalendarReads } from '../src/calendarReads.mjs'
import { classScanFrom } from '../src/academicTerms.mjs'
import { DEFAULT_MAX_ROWS } from '../src/pagedSelect.mjs'
import { normalizeScheduleOverrides } from '../src/scheduleOverrides.mjs'
import { fakeSupabase, hasCall } from './routes/fakeSupabase.mjs'

// Issue #191: the per-user calendar reads the me, assistant, study groups and
// friends routers share, built once over the Supabase client. Run here on the
// recording fake, so each test pins the query chain as well as the answer.

const USER = '11111111-1111-4111-8111-111111111111'
const COLUMNS = 'id, source_id, title, description, start_time, end_time, location, category, external_uid, source_type, all_day'
const FROM = '2026-09-20T04:00:00.000Z'

const select = { method: 'select', args: [COLUMNS] }
const ownRows = { method: 'eq', args: ['user_id', USER] }
const byStart = (ascending) => ({ method: 'order', args: ['start_time', { ascending }] })
const byId = (ascending) => ({ method: 'order', args: ['id', { ascending }] })

function calendarRow(overrides = {}) {
  return {
    id: 'c1',
    source_id: 'source-1',
    title: 'CS 18000 Lecture',
    description: null,
    start_time: '2026-10-05T13:30:00.000Z',
    end_time: '2026-10-05T14:45:00.000Z',
    location: 'LD 010',
    category: 'class',
    external_uid: 'uid-c1',
    source_type: 'purdue_schedule_ical',
    all_day: false,
    ...overrides,
  }
}

// The rows a paged read asked for: the fake answers the .range() window.
function pageOf(rows, chain) {
  const range = chain.find((call) => call.method === 'range')
  if (!range) return rows
  const [from, to] = range.args
  return rows.slice(from, to + 1)
}

test('listCalendarItems: one bounded query scoped to the student, by start_time then id, mapped for the client', async () => {
  const rows = [
    calendarRow(),
    calendarRow({
      id: 'c2',
      source_id: null,
      title: 'Free pizza at the involvement fair',
      description: 'Bring a friend',
      category: 'campus_event',
      external_uid: null,
      all_day: true,
    }),
  ]
  const supabase = fakeSupabase({ calendar_items: () => ({ data: rows, error: null }) })
  const { listCalendarItems } = createCalendarReads(supabase)
  const items = await listCalendarItems(USER)

  assert.equal(supabase.queries.length, 1)
  const [{ chain }] = supabase.queriesOf('calendar_items')
  assert.deepEqual(chain, [select, ownRows, byStart(true), byId(true), { method: 'limit', args: [100] }])
  assert.deepEqual(items, [
    {
      id: 'c1',
      sourceId: 'source-1',
      title: 'CS 18000 Lecture',
      description: null,
      startTime: '2026-10-05T13:30:00.000Z',
      endTime: '2026-10-05T14:45:00.000Z',
      location: 'LD 010',
      category: 'class',
      externalUid: 'uid-c1',
      sourceType: 'purdue_schedule_ical',
      allDay: false,
      freeFood: false,
    },
    {
      id: 'c2',
      sourceId: null,
      title: 'Free pizza at the involvement fair',
      description: 'Bring a friend',
      startTime: '2026-10-05T13:30:00.000Z',
      endTime: '2026-10-05T14:45:00.000Z',
      location: 'LD 010',
      category: 'campus_event',
      externalUid: null,
      sourceType: 'purdue_schedule_ical',
      allDay: true,
      freeFood: true,
    },
  ])
})

test('listCalendarItems: category is an eq and wins over categories, categories an in, from a gte, and order flips both sorts', async () => {
  const supabase = fakeSupabase({ calendar_items: () => ({ data: [], error: null }) })
  const { listCalendarItems } = createCalendarReads(supabase)
  await listCalendarItems(USER, { category: 'exam', categories: ['quiz'], limit: 5, from: FROM })
  await listCalendarItems(USER, { categories: ['exam', 'quiz'], order: 'desc' })
  await listCalendarItems(USER, { categories: [] })

  const [one, two, three] = supabase.queriesOf('calendar_items').map((q) => q.chain)
  assert.deepEqual(one, [
    select,
    ownRows,
    { method: 'eq', args: ['category', 'exam'] },
    { method: 'gte', args: ['start_time', FROM] },
    byStart(true),
    byId(true),
    { method: 'limit', args: [5] },
  ])
  assert.deepEqual(two, [
    select,
    ownRows,
    { method: 'in', args: ['category', ['exam', 'quiz']] },
    byStart(false),
    byId(false),
    { method: 'limit', args: [100] },
  ])
  assert.deepEqual(three, [select, ownRows, byStart(true), byId(true), { method: 'limit', args: [100] }])
})

test('listCalendarItems: a read past the 1000-row max pages with range(), every page filtered and ordered the same', async () => {
  const rows = Array.from({ length: 2300 }, (_, i) => calendarRow({ id: `c${i}` }))
  const supabase = fakeSupabase({ calendar_items: (chain) => ({ data: pageOf(rows, chain), error: null }) })
  const { listCalendarItems } = createCalendarReads(supabase)
  const items = await listCalendarItems(USER, { category: 'class', limit: 5000, from: FROM })

  assert.equal(items.length, 2300)
  assert.deepEqual(items.slice(-1).map((item) => item.id), ['c2299'])
  const pages = supabase.queriesOf('calendar_items').map((q) => q.chain)
  assert.deepEqual(
    pages.map((chain) => chain.find((call) => call.method === 'range').args),
    [[0, 999], [1000, 1999], [2000, 2999]],
    'a short third page ends the read',
  )
  for (const chain of pages) {
    assert.deepEqual(chain.slice(0, -1), [
      select,
      ownRows,
      { method: 'eq', args: ['category', 'class'] },
      { method: 'gte', args: ['start_time', FROM] },
      byStart(true),
      byId(true),
    ])
    assert.ok(!hasCall(chain, 'limit'), 'a paged read never falls back to one truncated .limit()')
  }
})

test('listCalendarItems: a failed read answers an empty list', async () => {
  const supabase = fakeSupabase({ calendar_items: () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }) })
  const { listCalendarItems } = createCalendarReads(supabase)
  assert.deepEqual(await listCalendarItems(USER), [])
  assert.deepEqual(await listCalendarItems(USER, { limit: 2500 }), [])
})

// Class meetings, built in local time the way getAcademicTerm reads them back,
// so the term pick is the same in any time zone. "Now" is pinned to the
// afternoon of 2026-10-04, in the fall 2026 term.
const NOW = new Date(2026, 9, 4, 12, 0, 0)
const at = (month, day) => new Date(2026, month - 1, day, 9, 0, 0)

function classRow(id, start) {
  return calendarRow({
    id,
    title: `Class ${id}`,
    start_time: start.toISOString(),
    end_time: new Date(start.getTime() + 75 * 60 * 1000).toISOString(),
    external_uid: `uid-${id}`,
  })
}

const SPRING = [classRow('spring-1', at(2, 2)), classRow('spring-2', at(4, 6))]
const FALL = [classRow('fall-1', at(9, 14)), classRow('fall-2', at(10, 5)), classRow('fall-3', at(10, 7)), classRow('fall-4', at(12, 1))]

function classReads(rows) {
  const supabase = fakeSupabase({ calendar_items: (chain) => ({ data: pageOf(rows, chain), error: null }) })
  return { supabase, reads: createCalendarReads(supabase) }
}

test('getClassItemsForUser: the class scan reads from classScanFrom(term), paged; no rows answers an empty meta', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const { supabase, reads } = classReads([])
  const answer = await reads.getClassItemsForUser(USER)

  assert.deepEqual(answer, { items: [], meta: { selectedTermKey: null, selectedTermLabel: null, totalInTerm: 0 } })
  assert.equal(supabase.queries.length, 1, 'an empty first page ends the scan')
  assert.deepEqual(supabase.queries[0].chain, [
    select,
    ownRows,
    { method: 'eq', args: ['category', 'class'] },
    { method: 'gte', args: ['start_time', classScanFrom('auto', { now: NOW })] },
    byStart(true),
    byId(true),
    { method: 'range', args: [0, 999] },
  ])
})

test('getClassItemsForUser: the scan stops at DEFAULT_MAX_ROWS class rows, 1000 a page', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const rows = Array.from({ length: DEFAULT_MAX_ROWS + 500 }, (_, i) => classRow(`c${i}`, at(10, 5)))
  const { supabase, reads } = classReads(rows)
  const answer = await reads.getClassItemsForUser(USER)

  const ranges = supabase.queriesOf('calendar_items').map((q) => q.chain.find((call) => call.method === 'range').args)
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999], [3000, 3999], [4000, 4999]])
  assert.equal(answer.meta.totalInTerm, DEFAULT_MAX_ROWS)
  assert.equal(answer.items.length, 20, 'the default limit')
})

test("getClassItemsForUser: 'auto' picks the current term, and display mode keeps its meetings still ahead, soonest first", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const { reads } = classReads([...SPRING, ...FALL])
  const answer = await reads.getClassItemsForUser(USER)

  assert.deepEqual(answer.items.map((item) => item.id), ['fall-2', 'fall-3', 'fall-4'])
  assert.deepEqual(answer.meta, { selectedTermKey: '2026-fall', selectedTermLabel: 'Fall 2026', totalInTerm: 4 })
  // The client's camelCase item; display ordering leaves the snake_case times
  // it sorted by on each item, as the API always has.
  assert.deepEqual(answer.items[0], {
    id: 'fall-2',
    sourceId: 'source-1',
    title: 'Class fall-2',
    description: null,
    startTime: FALL[1].start_time,
    endTime: FALL[1].end_time,
    location: 'LD 010',
    category: 'class',
    externalUid: 'uid-fall-2',
    sourceType: 'purdue_schedule_ical',
    allDay: false,
    freeFood: false,
    start_time: FALL[1].start_time,
    end_time: FALL[1].end_time,
  })
})

test('getClassItemsForUser: any other mode lists the whole term by start time', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const { reads } = classReads([...SPRING, FALL[3], FALL[1], FALL[0], FALL[2]])
  const answer = await reads.getClassItemsForUser(USER, { mode: 'list' })

  assert.deepEqual(answer.items.map((item) => item.id), ['fall-1', 'fall-2', 'fall-3', 'fall-4'])
  assert.equal('start_time' in answer.items[0], false)
  assert.equal(answer.meta.totalInTerm, 4)
})

test("getClassItemsForUser: an explicit term key widens the scan to its start, and 'all' keeps every term", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const spring = classReads([...SPRING, ...FALL])
  const past = await spring.reads.getClassItemsForUser(USER, { term: '2026-spring' })
  const springFrom = classScanFrom('2026-spring', { now: NOW })
  assert.notEqual(springFrom, classScanFrom('auto', { now: NOW }))
  assert.ok(hasCall(spring.supabase.queries[0].chain, 'gte', 'start_time', springFrom))
  // A term with no meeting left shows its meetings latest first.
  assert.deepEqual(past.items.map((item) => item.id), ['spring-2', 'spring-1'])
  assert.deepEqual(past.meta, { selectedTermKey: '2026-spring', selectedTermLabel: 'Spring 2026', totalInTerm: 2 })

  const every = classReads([...SPRING, ...FALL])
  const all = await every.reads.getClassItemsForUser(USER, { term: 'all' })
  assert.ok(hasCall(every.supabase.queries[0].chain, 'gte', 'start_time', classScanFrom('all', { now: NOW })))
  assert.deepEqual(all.items.map((item) => item.id), ['fall-2', 'fall-3', 'fall-4'])
  assert.deepEqual(all.meta, { selectedTermKey: null, selectedTermLabel: null, totalInTerm: 6 })
})

test('getClassItemsForUser: 20 items by default, or the limit asked for', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const rows = Array.from({ length: 25 }, (_, i) => classRow(`fall-${String(i).padStart(2, '0')}`, new Date(2026, 9, 5 + i, 9, 0, 0)))
  const { reads } = classReads(rows)
  const byDefault = await reads.getClassItemsForUser(USER)
  assert.equal(byDefault.items.length, 20)
  assert.equal(byDefault.items[0].id, 'fall-00')
  assert.equal(byDefault.meta.totalInTerm, 25)
  const three = await reads.getClassItemsForUser(USER, { limit: 3 })
  assert.deepEqual(three.items.map((item) => item.id), ['fall-00', 'fall-01', 'fall-02'])
})

test("readScheduleOverrides: one maybeSingle read of the student's row, normalized; no row or an error is the empty shape", async () => {
  const stored = { series: { 'CS 18000|Lecture': { code: '  CS 18000 ', hidden: true, junk: 'x' } }, manual: 'not-a-list' }
  let answer = { data: stored, error: null }
  const supabase = fakeSupabase({ user_schedule_overrides: () => answer })
  const { readScheduleOverrides } = createCalendarReads(supabase)

  const overrides = await readScheduleOverrides(USER)
  assert.deepEqual(overrides, normalizeScheduleOverrides(stored))
  assert.deepEqual(overrides, { series: { 'CS 18000|Lecture': { code: 'CS 18000', hidden: true } }, manual: [] })
  assert.deepEqual(supabase.queries[0].chain, [
    { method: 'select', args: ['series, manual'] },
    { method: 'eq', args: ['user_id', USER] },
    { method: 'maybeSingle', args: [] },
  ])

  answer = { data: null, error: null }
  assert.deepEqual(await readScheduleOverrides(USER), { series: {}, manual: [] })
  answer = { data: stored, error: { code: 'PGRST205', message: "Could not find the table 'public.user_schedule_overrides'" } }
  assert.deepEqual(await readScheduleOverrides(USER), { series: {}, manual: [] })
})

test('each call to createCalendarReads reads through its own client', async () => {
  const first = fakeSupabase({ calendar_items: () => ({ data: [], error: null }) })
  const second = fakeSupabase({ calendar_items: () => ({ data: [calendarRow()], error: null }) })
  const a = createCalendarReads(first)
  const b = createCalendarReads(second)
  assert.deepEqual(await a.listCalendarItems(USER), [])
  assert.equal((await b.listCalendarItems(USER)).length, 1)
  assert.equal(first.queries.length, 1)
  assert.equal(second.queries.length, 1)
})
