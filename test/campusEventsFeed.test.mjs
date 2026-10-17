// Tests for the read side of the shared campus events (issue #30): which
// campus_events rows a calendar read lists, in what shape, and what the query
// asks the database. The rules run on hand-made rows and on the rows the
// ingest plans from the real listings of 2026-10-17 (test/fixtures), the
// query on the recording fake the router tests use.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  HIDDEN_VENUE_KINDS,
  SHARED_CALENDAR_CATEGORIES,
  SHARED_EVENTS_MAX_ROWS,
  SOURCE_LABELS,
  STALE_AFTER_MS,
  listSharedCalendarItems,
  planSharedCalendarItems,
  sharedCalendarCategory,
  sharedCategoriesFor,
  toSharedCalendarItem,
} from '../src/campusEventsFeed.mjs'
import { SOURCES, VENUE_KINDS, engageOrgLookup, planCampusEvents } from '../src/sharedEvents.mjs'
import { fakeSupabase } from './routes/fakeSupabase.mjs'

const NOW = new Date('2026-10-17T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const at = (ms) => new Date(NOW.getTime() + ms).toISOString()

let seq = 0
function campusRow(overrides = {}) {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    title: `Event ${seq}`,
    description: 'Free pizza in the atrium',
    starts_at: at(2 * DAY),
    ends_at: at(2 * DAY + 2 * HOUR),
    location: 'Campus Center 450',
    all_day: false,
    source_key: 'purdue_events',
    source_url: 'https://events.purdue.edu/event/leap',
    category: 'social',
    free_food: false,
    venue_kind: 'indy_campus',
    open_to_all: true,
    series_key: `purdue_events:series${seq}`,
    last_seen_at: at(-2 * HOUR),
    ...overrides,
  }
}
const titles = (items) => items.map((item) => item.title)

test('sharedCategoriesFor: category wins over categories, no filter asks for both, and only the shared two can come back', () => {
  assert.deepEqual(SHARED_CALENDAR_CATEGORIES, ['campus_event', 'deadline'])
  assert.deepEqual(sharedCategoriesFor(), ['campus_event', 'deadline'])
  assert.deepEqual(sharedCategoriesFor({ category: null, categories: [] }), ['campus_event', 'deadline'])
  // The Events and Free Food window.
  assert.deepEqual(sharedCategoriesFor({ categories: ['campus_event', 'event', 'deadline'] }), ['campus_event', 'deadline'])
  assert.deepEqual(sharedCategoriesFor({ categories: ['deadline', 'exam'] }), ['deadline'])
  assert.deepEqual(sharedCategoriesFor({ category: 'exam', categories: ['campus_event'] }), [])
  assert.deepEqual(sharedCategoriesFor({ category: 'campus_event' }), ['campus_event'])
})

test('a row maps to the calendar item shape, marked shared, with its source label and an http(s) link only', () => {
  const row = campusRow({ id: 'a1b2', title: 'LEAP Retreat', free_food: true, all_day: false })
  assert.deepEqual(toSharedCalendarItem(row), {
    id: 'campus:a1b2',
    sourceId: null,
    title: 'LEAP Retreat',
    description: 'Free pizza in the atrium',
    startTime: row.starts_at,
    endTime: row.ends_at,
    location: 'Campus Center 450',
    category: 'campus_event',
    externalUid: null,
    sourceType: 'campus',
    allDay: false,
    freeFood: true,
    shared: true,
    sourceKey: 'purdue_events',
    sourceLabel: 'Purdue event',
    sourceUrl: 'https://events.purdue.edu/event/leap',
  })

  // Purdue's "Dates and Deadlines" are deadlines; every other category, and none, a campus event.
  assert.equal(sharedCalendarCategory('deadline'), 'deadline')
  for (const category of ['career', 'sports_fitness', 'other', null]) assert.equal(sharedCalendarCategory(category), 'campus_event')

  // IU Indianapolis's own listings read as IU events until the owner decides on #30.
  assert.equal(toSharedCalendarItem(campusRow({ source_key: 'iu_events' })).sourceLabel, 'IU event')
  assert.deepEqual(Object.keys(SOURCE_LABELS).sort(), SOURCES.map((source) => source.key).sort())
  assert.equal(toSharedCalendarItem(campusRow({ source_key: 'white_river' })).sourceLabel, 'Campus calendar')

  const missing = toSharedCalendarItem(campusRow({ description: null, ends_at: null, location: null, source_url: null }))
  assert.deepEqual([missing.description, missing.endTime, missing.location, missing.sourceUrl], [null, null, null, null])
  assert.equal(toSharedCalendarItem(campusRow({ source_url: 'javascript:alert(1)' })).sourceUrl, null)
})

test('a row the ingest has not written for 26 hours is gone; one written just inside the window stays', () => {
  assert.equal(STALE_AFTER_MS, 26 * HOUR)
  const rows = [
    campusRow({ title: 'Seen this morning', last_seen_at: at(-6 * HOUR) }),
    campusRow({ title: 'Seen just inside', last_seen_at: at(-STALE_AFTER_MS) }),
    campusRow({ title: 'Seen two days ago', last_seen_at: at(-2 * DAY) }),
  ]
  assert.deepEqual(titles(planSharedCalendarItems(rows, { now: NOW })), ['Seen this morning', 'Seen just inside'])
})

test('only rows not over yet: one still running is listed, an all-day row without an end runs to the end of its day', () => {
  const rows = [
    campusRow({ title: 'Ended an hour ago', starts_at: at(-3 * HOUR), ends_at: at(-HOUR) }),
    campusRow({ title: 'Running now', starts_at: at(-HOUR), ends_at: at(HOUR) }),
    campusRow({ title: 'Exhibit through next week', starts_at: at(-10 * DAY), ends_at: at(7 * DAY) }),
    campusRow({ title: 'Started, no end', starts_at: at(-10 * 60 * 1000), ends_at: null }),
    campusRow({ title: 'All day today', starts_at: at(-8 * HOUR), ends_at: null, all_day: true }),
    campusRow({ title: 'All day yesterday', starts_at: at(-32 * HOUR), ends_at: null, all_day: true }),
    campusRow({ title: 'Later, no end', starts_at: at(3 * HOUR), ends_at: null }),
  ]
  assert.deepEqual(titles(planSharedCalendarItems(rows, { now: NOW })), [
    'Exhibit through next week',
    'All day today',
    'Running now',
    'Later, no end',
  ])

  // A `from` past now (a read of next week on) also drops what is over by then.
  const since = new Date(NOW.getTime() + 2 * HOUR)
  assert.deepEqual(titles(planSharedCalendarItems(rows, { now: NOW, since })), ['Exhibit through next week', 'All day today', 'Later, no end'])
})

test('West Lafayette and other-city rows, and members-only sessions, are never listed; online and unknown places are', () => {
  assert.deepEqual(HIDDEN_VENUE_KINDS, ['elsewhere', 'west_lafayette'])
  const rows = VENUE_KINDS.map((venueKind) => campusRow({ title: venueKind, venue_kind: venueKind }))
  assert.deepEqual(titles(planSharedCalendarItems(rows, { now: NOW })), ['indy_campus', 'online', 'unknown'])

  const audience = [
    campusRow({ title: 'Open to students', open_to_all: true }),
    campusRow({ title: 'Nothing said', open_to_all: null }),
    campusRow({ title: 'Club tennis practice', open_to_all: false }),
  ]
  assert.deepEqual(titles(planSharedCalendarItems(audience, { now: NOW })), ['Open to students', 'Nothing said'])
})

test('a series shows once, as its next occurrence; rows with no series key each stand alone', () => {
  const rows = [
    campusRow({ title: 'Yoga Thursday', series_key: 'iu_events:yoga', starts_at: at(5 * DAY), ends_at: at(5 * DAY + HOUR) }),
    campusRow({ title: 'Yoga ended this morning', series_key: 'iu_events:yoga', starts_at: at(-3 * HOUR), ends_at: at(-2 * HOUR) }),
    campusRow({ title: 'Yoga tomorrow', series_key: 'iu_events:yoga', starts_at: at(DAY), ends_at: at(DAY + HOUR) }),
    campusRow({ title: 'Loose one', series_key: null, starts_at: at(3 * DAY) }),
    campusRow({ title: 'Another loose one', series_key: null, starts_at: at(4 * DAY) }),
  ]
  assert.deepEqual(titles(planSharedCalendarItems(rows, { now: NOW })), ['Yoga tomorrow', 'Loose one', 'Another loose one'])
})

test('categories pick deadlines, campus events or both, and the list is in start order with an id tiebreak', () => {
  const rows = [
    campusRow({ id: 'b', title: 'Thanksgiving Vacation', category: 'deadline', starts_at: at(DAY), all_day: true, ends_at: null }),
    campusRow({ id: 'a', title: 'Founders Table', category: null, starts_at: at(DAY), ends_at: at(DAY + HOUR) }),
    campusRow({ id: 'c', title: 'Career fair', category: 'career', starts_at: at(HOUR) }),
  ]
  assert.deepEqual(titles(planSharedCalendarItems(rows, { now: NOW })), ['Career fair', 'Founders Table', 'Thanksgiving Vacation'])
  assert.deepEqual(titles(planSharedCalendarItems(rows, { now: NOW, categories: ['deadline'] })), ['Thanksgiving Vacation'])
  assert.deepEqual(titles(planSharedCalendarItems(rows, { now: NOW, categories: ['campus_event'] })), ['Career fair', 'Founders Table'])
  assert.deepEqual(planSharedCalendarItems(rows, { now: NOW, categories: [] }), [])
  assert.deepEqual(planSharedCalendarItems(null, { now: NOW }), [])
})

test('the rows the ingest planned from the 2026-10-17 listings: 33 rows list as 28', () => {
  const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
  const plan = planCampusEvents(
    {
      purdue_events: fixture('campus-events-localist.json').events.map((wrapper) => wrapper.event),
      iu_events: fixture('campus-events-livewhale.json').data,
      boilerlink: fixture('campus-events-boilerlink.json').value,
      thespot: fixture('campus-events-thespot.json').value,
    },
    // BoilerLink organizations by name alone, as with an empty club directory.
    { isIndianapolisOrg: engageOrgLookup([]) },
  )
  assert.equal(plan.rows.length, 33)
  // What the table adds on insert, the run having just finished.
  const stored = plan.rows.map((row) => ({ ...row, id: row.dedupe_key, last_seen_at: NOW.toISOString() }))
  const items = planSharedCalendarItems(stored, { now: NOW })

  // Two away games (venue_kind elsewhere), two club practices (members only)
  // and the second Yoga class of the day.
  assert.equal(items.length, 28)
  for (const gone of ['Wright State Tornament', 'College Night Oct', 'Fall 2026 practices part 2', 'Club Tennis Practice']) {
    assert.ok(!titles(items).includes(gone), gone)
  }
  assert.equal(titles(items).filter((title) => title === 'Yoga').length, 1)
  assert.equal(items.find((item) => item.title === 'Yoga').startTime, '2026-10-17T16:15:00.000Z')
  // The all-day exhibit opened at midnight and the multi-day one are still on.
  assert.ok(titles(items).includes('Sunlight on the Seafloor'))
  assert.ok(titles(items).includes('Andrew Winship: ÆNIGMATA'))
  assert.deepEqual(items.filter((item) => item.category === 'deadline').map((item) => item.title), ['Thanksgiving Vacation'])
  assert.equal(items.filter((item) => item.freeFood).length, 5)
  assert.ok(items.every((item) => item.shared === true && item.id.startsWith('campus:') && /^https:\/\//.test(item.sourceUrl)))
  const starts = items.map((item) => item.startTime)
  assert.deepEqual(starts, [...starts].sort())
})

test('the query narrows by the same rules, ordered and paged, and the answer is planned with the clock and from', async () => {
  const answered = [
    campusRow({ title: 'Ends tonight', starts_at: at(HOUR), ends_at: at(3 * HOUR) }),
    campusRow({ title: 'Next week', starts_at: at(7 * DAY), ends_at: at(7 * DAY + HOUR) }),
  ]
  const supabase = fakeSupabase({ campus_events: () => ({ data: answered, error: null }) })
  const items = await listSharedCalendarItems(supabase, { now: NOW })
  assert.deepEqual(titles(items), ['Ends tonight', 'Next week'])

  const [{ chain }] = supabase.queriesOf('campus_events')
  assert.deepEqual(chain, [
    {
      method: 'select',
      args: ['id, title, description, starts_at, ends_at, location, all_day, source_key, source_url, category, free_food, venue_kind, open_to_all, series_key, last_seen_at'],
    },
    { method: 'gte', args: ['last_seen_at', at(-STALE_AFTER_MS)] },
    { method: 'or', args: [`ends_at.gte.${NOW.toISOString()},starts_at.gte.${at(-DAY)}`] },
    { method: 'not', args: ['venue_kind', 'in', '(elsewhere,west_lafayette)'] },
    { method: 'not', args: ['open_to_all', 'is', false] },
    { method: 'order', args: ['starts_at', { ascending: true }] },
    { method: 'order', args: ['id', { ascending: true }] },
    // Past PostgREST's max-rows, so selectUpTo pages it.
    { method: 'range', args: [0, 999] },
  ])
  assert.equal(SHARED_EVENTS_MAX_ROWS, 3000)

  // A `from` later than now drops what is over by then; an earlier one changes nothing.
  assert.deepEqual(titles(await listSharedCalendarItems(supabase, { now: NOW, from: at(DAY) })), ['Next week'])
  assert.deepEqual(titles(await listSharedCalendarItems(supabase, { now: NOW, from: at(-14 * DAY) })), ['Ends tonight', 'Next week'])
  // Only deadlines asked for: none here.
  assert.deepEqual(await listSharedCalendarItems(supabase, { now: NOW, categories: ['deadline'] }), [])
})

test('no categories asked for means no query at all', async () => {
  const supabase = fakeSupabase({})
  assert.deepEqual(await listSharedCalendarItems(supabase, { now: NOW, categories: [] }), [])
  assert.equal(supabase.queries.length, 0)
})

test('a missing campus_events table answers [] and logs the file to run once; any other failure answers [] and logs every time', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.campus_events' in the schema cache (feed test)" }
  const failing = fakeSupabase({ campus_events: () => ({ data: null, error: missing }) })
  assert.deepEqual(await listSharedCalendarItems(failing, { now: NOW }), [])
  assert.deepEqual(await listSharedCalendarItems(failing, { now: NOW }), [])
  assert.equal(logged.mock.callCount(), 1)
  assert.match(logged.mock.calls[0].arguments[0], /\[campus_events\] schema missing: run db\/supabase-campus-events\.sql/)

  const timeout = { code: '57014', message: 'canceling statement due to statement timeout' }
  const slow = fakeSupabase({ campus_events: () => ({ data: null, error: timeout }) })
  assert.deepEqual(await listSharedCalendarItems(slow, { now: NOW }), [])
  assert.deepEqual(await listSharedCalendarItems(slow, { now: NOW }), [])
  assert.equal(logged.mock.callCount(), 3)
  assert.deepEqual(logged.mock.calls[2].arguments, ['%s:', 'campus_events read', '57014', 'canceling statement due to statement timeout'])
})
