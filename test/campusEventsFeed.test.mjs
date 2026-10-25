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
  PUBLIC_FREE_FOOD_MAX_ROWS,
  SHARED_CALENDAR_CATEGORIES,
  SHARED_EVENTS_MAX_ROWS,
  SOURCE_LABELS,
  STALE_AFTER_MS,
  applyDowntownSwitch,
  listSharedCalendarItems,
  planPublicFreeFoodItems,
  planSharedCalendarItems,
  readPublicFreeFoodRows,
  sharedCalendarCategory,
  sharedCategoriesFor,
  toSharedCalendarItem,
} from '../src/campusEventsFeed.mjs'
import { inTribeWindow } from '../src/campusEventsIngest.mjs'
import { DOWNTOWN_VENUE_KIND, SOURCES, VENUE_KINDS, engageOrgLookup, planCampusEvents, sourceByKey } from '../src/sharedEvents.mjs'
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
    organization_key: null,
    ...overrides,
  }
}
const titles = (items) => items.map((item) => item.title)

// What the reads ask campus_events for since README step 48, and before it.
const BASE_COLUMNS =
  'id, title, description, starts_at, ends_at, location, all_day, source_key, source_url, category, free_food, venue_kind, open_to_all, series_key, last_seen_at'
const COLUMNS_WITH_ORGANIZATION = `${BASE_COLUMNS}, organization_key`
const selectedColumns = (query) => query.chain.find((call) => call.method === 'select').args[0]
// PostgREST's answer to a select naming a column the table does not have yet.
const organizationKeyMissing = () => ({ code: '42703', message: 'column campus_events.organization_key does not exist' })

// The rows the ingest planned from the real listings of 2026-10-17, as the
// table holds them right after the run.
function storedFixtureRows() {
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
  // What the table adds on insert, the run having just finished.
  return { plan, stored: plan.rows.map((row) => ({ ...row, id: row.dedupe_key, last_seen_at: NOW.toISOString() })) }
}

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
    organizationKey: null,
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

// Issue #16: a club's events say which club listed them, and a student's read
// says which of those clubs the student follows. Only fields are added, never
// renamed or dropped: the native app reads these rows.
test('a row says which club listed it, and with the follows of a student whether it is one of theirs', () => {
  const club = campusRow({ source_key: 'boilerlink', organization_key: 'boilerlink:401442' })
  const calendar = campusRow({ source_key: 'purdue_events', organization_key: null })
  const before = campusRow({ source_key: 'boilerlink' })
  delete before.organization_key // read before README step 48 added the column

  // The signed-out read passes no follows: `organizationKey` only, no `followed`.
  assert.equal(toSharedCalendarItem(club).organizationKey, 'boilerlink:401442')
  assert.equal('followed' in toSharedCalendarItem(club), false)
  assert.equal(toSharedCalendarItem(before).organizationKey, null)

  const followedKeys = new Set(['boilerlink:401442'])
  const plain = toSharedCalendarItem(club)
  const marked = toSharedCalendarItem(club, { followedKeys })
  assert.deepEqual(marked, { ...plain, followed: true })
  assert.deepEqual(Object.keys(marked).slice(0, -1), Object.keys(plain), 'every field the app reads is still there, in order')
  assert.equal(toSharedCalendarItem(calendar, { followedKeys }).followed, false)
  assert.equal(toSharedCalendarItem(before, { followedKeys }).followed, false)
  assert.equal(toSharedCalendarItem(campusRow({ source_key: 'boilerlink', organization_key: 'boilerlink:24070' }), { followedKeys }).followed, false)
  assert.equal(toSharedCalendarItem(club, { followedKeys: new Set() }).followed, false)

  // The plan marks rows and never changes which are listed.
  const rows = [club, calendar]
  const items = planSharedCalendarItems(rows, { now: NOW, followedKeys })
  assert.deepEqual(titles(items), titles(planSharedCalendarItems(rows, { now: NOW })))
  assert.deepEqual(items.map((item) => item.followed), [true, false])
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

// Issue #30: White River State Park's rows are downtown. The read lists them,
// says "Downtown", and drops them whenever CAMPUS_EVENTS_DOWNTOWN is off.
test('downtown rows are listed with the Downtown label, and only while CAMPUS_EVENTS_DOWNTOWN is on', () => {
  assert.ok(!HIDDEN_VENUE_KINDS.includes(DOWNTOWN_VENUE_KIND))
  const museum = campusRow({
    title: 'Twilight Tales',
    source_key: 'wrsp_events',
    venue_kind: DOWNTOWN_VENUE_KIND,
    location: 'Indiana State Museum, 650 West Washington Street, Indianapolis',
    source_url: 'https://whiteriverstatepark.org/event/twilight-tales/',
  })
  const leap = campusRow({ title: 'LEAP Retreat' })
  const items = planSharedCalendarItems([museum, leap], { now: NOW })
  assert.deepEqual(titles(items), ['Twilight Tales', 'LEAP Retreat'])
  assert.deepEqual(items[0], { ...toSharedCalendarItem(museum), sourceLabel: 'Downtown' })
  assert.equal(SOURCE_LABELS.wrsp_events, 'Downtown')
  assert.equal(items[0].sourceUrl, 'https://whiteriverstatepark.org/event/twilight-tales/')

  assert.deepEqual(titles(applyDowntownSwitch(items, true)), ['Twilight Tales', 'LEAP Retreat'])
  assert.deepEqual(titles(applyDowntownSwitch(items, false)), ['LEAP Retreat'])
  // Off means the source, whatever the venue of one of its rows.
  const webinar = toSharedCalendarItem(campusRow({ title: 'Webinar', source_key: 'wrsp_events', venue_kind: 'online' }))
  assert.deepEqual(applyDowntownSwitch([webinar], false), [])
  assert.deepEqual(applyDowntownSwitch([], false), [])
})

test("the park's listings of 2026-10-24, fetched and planned by the ingest, list as 17 Downtown rows", () => {
  const source = sourceByKey('wrsp_events')
  const fetchedAt = new Date('2026-10-24T21:30:00.000Z')
  const listings = JSON.parse(readFileSync(new URL('./fixtures/campus-events-wrsp.json', import.meta.url), 'utf8')).events
  const { rows } = planCampusEvents({ wrsp_events: listings.filter((raw) => inTribeWindow(raw, source, fetchedAt)) })
  assert.equal(rows.length, 19)
  const stored = rows.map((row) => ({ ...row, id: row.dedupe_key, last_seen_at: fetchedAt.toISOString() }))
  const items = planSharedCalendarItems(stored, { now: fetchedAt })
  // Twilight Tales: Beyond the Grave and the zoo's sensory-friendly evening are on twice, and listed once.
  assert.equal(items.length, 17)
  assert.ok(items.every((item) => item.shared && item.sourceLabel === 'Downtown' && item.category === 'campus_event' && !item.freeFood))
  assert.equal(titles(items).filter((title) => title === 'Twilight Tales: Beyond the Grave (18+)').length, 1)
  // Still on at 5:30 PM: the Día de Muertos celebration until 7, and the day's IMAX screening.
  assert.deepEqual(titles(items).slice(0, 3), ['Apocalypse Now Final Cut: The IMAX Experience', 'Día de Muertos Community Celebration (FREE DAY)', 'Trail & Treat on the Canal'])
  assert.deepEqual(applyDowntownSwitch(items, false), [])
  assert.deepEqual(planPublicFreeFoodItems(stored, { now: fetchedAt }), [])
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

test('the rows the ingest planned from the 2026-10-17 listings: 31 rows list as 26', () => {
  const { plan, stored } = storedFixtureRows()
  // The medical school's ICMH Journal Club and Faculty Crossing's Scholarly Writing
  // drop at the ingest (LIVEWHALE_EXCLUDED_GROUPS).
  assert.equal(plan.rows.length, 31)
  const items = planSharedCalendarItems(stored, { now: NOW })

  // Two away games (venue_kind elsewhere), two club practices (members only)
  // and the second Yoga class of the day.
  assert.equal(items.length, 26)
  for (const gone of ['Wright State Tornament', 'College Night Oct', 'Fall 2026 practices part 2', 'Club Tennis Practice', 'ICMH Journal Club', 'Scholarly Writing - ONLINE ONLY']) {
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
    { method: 'select', args: [COLUMNS_WITH_ORGANIZATION] },
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
  // No student, no follows read: every row has `organizationKey` and no `followed`.
  assert.deepEqual(supabase.queries.map((query) => query.table), Array(4).fill('campus_events'))
  assert.ok(items.every((item) => item.organizationKey === null && !('followed' in item)))
})

test("a student's read marks the rows of the clubs they follow, read from club_follows alongside", async () => {
  const answered = [
    campusRow({ title: 'Taekwondo open mat', source_key: 'boilerlink', organization_key: 'boilerlink:401442', starts_at: at(HOUR) }),
    campusRow({ title: 'Climbing night', source_key: 'boilerlink', organization_key: 'boilerlink:420527', starts_at: at(2 * HOUR) }),
    campusRow({ title: 'LEAP Retreat', starts_at: at(3 * HOUR) }),
  ]
  const supabase = fakeSupabase({
    campus_events: () => ({ data: answered, error: null }),
    club_follows: () => ({ data: [{ organization_key: 'boilerlink:401442' }, { organization_key: 'boilerlink:24070' }], error: null }),
  })
  const items = await listSharedCalendarItems(supabase, { now: NOW, userId: 'u1' })
  assert.deepEqual(items.map((item) => [item.title, item.organizationKey, item.followed]), [
    ['Taekwondo open mat', 'boilerlink:401442', true],
    ['Climbing night', 'boilerlink:420527', false],
    ['LEAP Retreat', null, false],
  ])
  const [follows] = supabase.queriesOf('club_follows')
  assert.deepEqual(follows.chain, [
    { method: 'select', args: ['organization_key'] },
    { method: 'eq', args: ['user_id', 'u1'] },
  ])
})

test('before README step 48 the reads go on without organization_key and club_follows, naming the file once', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const answered = [campusRow({ title: 'Taekwondo open mat', source_key: 'boilerlink' })]
  for (const row of answered) delete row.organization_key
  const supabase = fakeSupabase({
    campus_events: (chain) =>
      chain.some((call) => call.method === 'select' && call.args[0].includes('organization_key'))
        ? { data: null, error: organizationKeyMissing() }
        : { data: answered, error: null },
    club_follows: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.club_follows' in the schema cache (feed test)" } }),
  })
  const items = await listSharedCalendarItems(supabase, { now: NOW, userId: 'u1' })
  // No follows to read: the row is not marked at all, rather than marked "not followed".
  assert.deepEqual(items.map((item) => [item.title, item.organizationKey, 'followed' in item]), [['Taekwondo open mat', null, false]])
  assert.deepEqual(supabase.queriesOf('campus_events').map(selectedColumns), [COLUMNS_WITH_ORGANIZATION, BASE_COLUMNS])

  // The public read falls back the same way.
  assert.deepEqual(await readPublicFreeFoodRows(supabase, { now: NOW }), answered)
  assert.deepEqual(supabase.queriesOf('campus_events').map(selectedColumns).slice(2), [COLUMNS_WITH_ORGANIZATION, BASE_COLUMNS])

  // Each cause is logged once per process, both naming the club follows file.
  await listSharedCalendarItems(supabase, { now: NOW, userId: 'u1' })
  const lines = logged.mock.calls.map((call) => call.arguments[0])
  assert.equal(lines.length, 2)
  assert.ok(lines.every((line) => /^\[club_follows\] schema missing: run db\/supabase-club-follows\.sql/.test(line)), lines.join('\n'))
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

// ── The signed-out free-food read (issue #366) ──────────────────────────────

test('the signed-out free-food list holds only rows with free food, by every rule of the signed-in read', () => {
  const rows = [
    campusRow({ title: 'Pizza social', free_food: true, starts_at: at(DAY), ends_at: at(DAY + HOUR) }),
    campusRow({ title: 'No food', free_food: false }),
    campusRow({ title: 'Food not known', free_food: null }),
    campusRow({ title: 'Breakfast that ended', free_food: true, starts_at: at(-3 * HOUR), ends_at: at(-HOUR) }),
    campusRow({ title: 'Pizza nobody has listed for two days', free_food: true, last_seen_at: at(-2 * DAY) }),
    campusRow({ title: 'Pizza at Mackey', free_food: true, venue_kind: 'west_lafayette' }),
    campusRow({ title: 'Officers dinner', free_food: true, open_to_all: false }),
    campusRow({ title: 'Weekly lunch', free_food: true, series_key: 'iu_events:lunch', starts_at: at(3 * DAY), ends_at: at(3 * DAY + HOUR) }),
    campusRow({ title: 'Weekly lunch', free_food: true, series_key: 'iu_events:lunch', starts_at: at(10 * DAY), ends_at: at(10 * DAY + HOUR) }),
  ]
  const items = planPublicFreeFoodItems(rows, { now: NOW })
  assert.deepEqual(titles(items), ['Pizza social', 'Weekly lunch'])
  // The client shape of the signed-in read, campus rows only.
  assert.deepEqual(items[0], toSharedCalendarItem(rows[0]))
  assert.equal(items[1].startTime, at(3 * DAY))
  assert.ok(items.every((item) => item.freeFood === true && item.shared === true && item.id.startsWith('campus:')))
  assert.deepEqual(planPublicFreeFoodItems(null, { now: NOW }), [])
})

test('on the 2026-10-17 listings the signed-out list is exactly the signed-in page\'s free food: 5 rows', () => {
  const { stored } = storedFixtureRows()
  const signedIn = planSharedCalendarItems(stored, { now: NOW }).filter((item) => item.freeFood)
  const signedOut = planPublicFreeFoodItems(stored, { now: NOW })
  assert.equal(signedOut.length, 5)
  assert.deepEqual(signedOut, signedIn)
})

test('the signed-out read asks campus_events alone for its free-food rows, by the same rules, in one capped page', async () => {
  const answered = [campusRow({ title: 'Pizza social', free_food: true })]
  const supabase = fakeSupabase({ campus_events: () => ({ data: answered, error: null }) })
  assert.deepEqual(await readPublicFreeFoodRows(supabase, { now: NOW }), answered)

  // Never a student's calendar_items: the fake throws for any table it was not handed.
  assert.deepEqual(supabase.queries.map((query) => query.table), ['campus_events'])
  assert.deepEqual(supabase.queries[0].chain, [
    { method: 'select', args: [COLUMNS_WITH_ORGANIZATION] },
    { method: 'gte', args: ['last_seen_at', at(-STALE_AFTER_MS)] },
    { method: 'or', args: [`ends_at.gte.${NOW.toISOString()},starts_at.gte.${at(-DAY)}`] },
    { method: 'not', args: ['venue_kind', 'in', '(elsewhere,west_lafayette)'] },
    { method: 'not', args: ['open_to_all', 'is', false] },
    { method: 'eq', args: ['free_food', true] },
    { method: 'order', args: ['starts_at', { ascending: true }] },
    { method: 'order', args: ['id', { ascending: true }] },
    { method: 'limit', args: [PUBLIC_FREE_FOOD_MAX_ROWS] },
  ])
  assert.equal(PUBLIC_FREE_FOOD_MAX_ROWS, 500)
  assert.deepEqual(await readPublicFreeFoodRows(fakeSupabase({ campus_events: () => ({ data: null, error: null }) }), { now: NOW }), [])
})

// The calendar read answers [] on a failure, which there means "the
// student's rows alone"; a public [] would mean "no free food" to everyone.
test('the signed-out read throws a failure instead of answering none', async () => {
  for (const error of [
    { code: 'PGRST205', message: "Could not find the table 'public.campus_events' in the schema cache (public read test)" },
    { code: '57014', message: 'canceling statement due to statement timeout' },
  ]) {
    const failing = fakeSupabase({ campus_events: () => ({ data: null, error }) })
    await assert.rejects(readPublicFreeFoodRows(failing, { now: NOW }), (thrown) => thrown === error)
  }
})
