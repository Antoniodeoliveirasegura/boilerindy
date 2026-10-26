// Real-parse regression test for the node-ical upgrade (issue #118).
//
// The pure-core tests (scheduleSync.test.mjs) use synthetic fixtures, so they
// cannot catch a change in node-ical's PARSED OUTPUT - and 0.26 swapped the
// recurrence engine (rrule → rrule-temporal) and dropped moment. This test
// feeds a real .ics string through node-ical and pins exactly the shape
// scheduleSync relies on: JS Date start/end, `.type`, `{ params, val }` text,
// all-day `datetype`, VTIMEZONE detection, and an `.rrule` whose `.between()`
// returns JS Dates. If a bump breaks any of that, this fails loudly instead of
// silently mis-syncing every student's schedule.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import ical from 'node-ical'

import { detectTimezoneFromFeed, expandRecurringEvents, icalText, planSync } from '../src/scheduleSync.mjs'

const TZ = 'America/Indiana/Indianapolis'

// Purdue-style feed: a weekly recurring lecture (tagged SUMMARY, EXDATE) inside
// an explicit VTIMEZONE, plus an all-day event. The lecture's DTSTART is
// anchored in the past so the unbounded RRULE always yields occurrences inside
// expandRecurringEvents' rolling ±window, keeping the test time-stable.
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Purdue//Schedule//EN',
  'BEGIN:VTIMEZONE',
  'TZID:America/Indiana/Indianapolis',
  'BEGIN:STANDARD',
  'DTSTART:20201101T020000',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:20200308T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:lecture-cs180@purdue.edu',
  'DTSTART;TZID=America/Indiana/Indianapolis:20200101T093000', // 2020-01-01 is a Wednesday
  'DTEND;TZID=America/Indiana/Indianapolis:20200101T102000',
  'RRULE:FREQ=WEEKLY;BYDAY=WE',
  'EXDATE;TZID=America/Indiana/Indianapolis:20200108T093000',
  'SUMMARY;LANGUAGE=en-US:CS 180 Lecture',
  'LOCATION:LWSN B155',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:holiday-4jul@purdue.edu',
  'DTSTART;VALUE=DATE:20260704',
  'DTEND;VALUE=DATE:20260705',
  'SUMMARY:Independence Day',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

test('node-ical parses a real feed into the shape scheduleSync depends on', async () => {
  const parsed = await ical.async.parseICS(ICS)
  const events = Object.values(parsed).filter((e) => e?.type === 'VEVENT')
  assert.equal(events.length, 2)

  const lecture = events.find((e) => String(e.uid).startsWith('lecture'))
  const holiday = events.find((e) => String(e.uid).startsWith('holiday'))

  // Timed event: JS Date start/end - the type expandRecurringEvents/planSync read.
  assert.ok(lecture.start instanceof Date, 'start is a Date')
  assert.ok(lecture.end instanceof Date, 'end is a Date')
  assert.equal(icalText(lecture.summary), 'CS 180 Lecture') // SUMMARY;LANGUAGE → { params, val }
  assert.equal(icalText(lecture.location), 'LWSN B155')

  // All-day event: datetype drives the all_day column.
  assert.equal(holiday.datetype, 'date')
  assert.equal(icalText(holiday.summary), 'Independence Day')

  // Timezone detection resolves to the feed's zone (VTIMEZONE tzid or start.tz).
  assert.equal(detectTimezoneFromFeed(parsed), TZ)
})

test('parsed RRULE exposes .between() returning JS Dates (survives rrule → rrule-temporal)', async () => {
  const parsed = await ical.async.parseICS(ICS)
  const lecture = Object.values(parsed).find(
    (e) => e?.type === 'VEVENT' && String(e.uid).startsWith('lecture'),
  )

  assert.ok(lecture.rrule, 'recurring event carries an rrule')
  assert.ok(lecture.exdate, 'EXDATE parsed into exdate')

  // Deterministic window: Wednesdays in Jan 2026 → Jan 7, 14, 21, 28.
  const dates = lecture.rrule.between(
    new Date('2026-01-05T00:00:00Z'),
    new Date('2026-02-01T00:00:00Z'),
    true,
  )
  assert.ok(Array.isArray(dates), 'between() returns an array')
  assert.equal(dates.length, 4)
  for (const d of dates) {
    assert.ok(d instanceof Date, 'occurrence is a JS Date')
    assert.ok(Number.isInteger(d.getUTCFullYear()), 'exposes getUTC* like expandRecurringEvents needs')
  }
})

test('expandRecurringEvents consumes real parsed rrule output', async () => {
  const parsed = await ical.async.parseICS(ICS)
  const lecture = Object.values(parsed).find(
    (e) => e?.type === 'VEVENT' && String(e.uid).startsWith('lecture'),
  )

  const out = expandRecurringEvents([lecture], TZ)
  // Unbounded weekly rule → many occurrences in the rolling window; the exact
  // count is date-dependent, so assert the invariants, not the number.
  assert.ok(out.length > 4, 'expands into multiple occurrences')
  assert.ok(out.every((e) => e.start instanceof Date), 'every occurrence has a Date start')
  assert.ok(out.every((e) => e.rrule === undefined), 'rrule stripped from expanded occurrences')
})

// ── Brightspace feed through the real parser (#121) ─────────────────────────
//
// D2L emits an availability pair plus a due item for each deliverable, with
// the course code and a status marker folded into SUMMARY, and due items as a
// zero-length event at 23:59 local. Pins that a real parse plus planSync yields
// one clean, correctly categorised task per deliverable.
const BRIGHTSPACE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//D2L//Brightspace//EN',
  'BEGIN:VEVENT',
  'UID:hw5-starts@purdue.brightspace.com',
  'DTSTART:20260112T050000Z',
  'DTEND:20260112T050000Z',
  'SUMMARY:Homework 5 - ENGR 13300 - Availability Starts',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:hw5-ends@purdue.brightspace.com',
  'DTSTART:20260120T045900Z',
  'DTEND:20260120T045900Z',
  'SUMMARY:Homework 5 - ENGR 13300 - Availability Ends',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:hw5-due@purdue.brightspace.com',
  'DTSTART:20260119T045900Z',
  'DTEND:20260119T045900Z',
  'SUMMARY:Homework 5 - ENGR 13300 - Due',
  'DESCRIPTION:Submit via the dropbox.',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:lab-report-due@purdue.brightspace.com',
  'DTSTART:20260123T045900Z',
  'DTEND:20260123T045900Z',
  'SUMMARY;LANGUAGE=en-US:Lab Report - Week 2 - Due',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

test('a real Brightspace parse yields one clean task per deliverable (#121)', async () => {
  const parsed = await ical.async.parseICS(BRIGHTSPACE_ICS)
  const source = {
    id: 'src-bs',
    user_id: 'user-1',
    source_type: 'brightspace_ical',
    source_url: 'https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=x',
  }
  const plan = planSync(parsed, source)

  assert.deepEqual(
    plan.itemsToInsert.map((i) => [i.title, i.category, i.start_time]),
    [
      ['Homework 5 - ENGR 13300', 'assignment', '2026-01-19T04:59:00.000Z'],
      ['Lab Report - Week 2', 'lab', '2026-01-23T04:59:00.000Z'],
    ],
  )
  // The raw summary survives for debugging and re-categorisation.
  assert.equal(plan.itemsToInsert[0].raw_json.summary, 'Homework 5 - ENGR 13300 - Due')
  assert.equal(plan.itemsToInsert[0].description, 'Submit via the dropbox.')
  assert.equal(plan.meta.rawCount, 4)
})

// ── Evening classes keep their own day ──────────────────────────────────────
//
// expandRecurringEvents rebuilds each weekly meeting from its calendar day and
// the series' wall-clock time. In Indianapolis a class at 7 PM EST or 8 PM EDT
// is already the next day in UTC, so reading the day there put a Monday
// evening class on Tuesday. node-ical files EXDATE and RECURRENCE-ID entries
// under the day in the event's own timezone, so those missed evening classes
// too. The expansion window is built from Date.now(), hence the fake clock.

const VTIMEZONE_RULES = [
  'BEGIN:VTIMEZONE',
  `TZID:${TZ}`,
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:20070311T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:20071104T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
]

const feed = (...events) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Purdue//Schedule//EN', ...VTIMEZONE_RULES, ...events.flat(), 'END:VCALENDAR', ''].join('\r\n')

const EVENING_ICS = feed(
  // Monday and Wednesday at 7 PM across the end of EDT (1 November 2026), with
  // Wednesday 4 November cancelled and Monday 9 November moved to 6 PM.
  [
    'BEGIN:VEVENT',
    'UID:stat30100-lecture@purdue.edu',
    `DTSTART;TZID=${TZ}:20261026T190000`,
    `DTEND;TZID=${TZ}:20261026T201500`,
    'RRULE:FREQ=WEEKLY;UNTIL=20261112T050000Z;BYDAY=MO,WE',
    `EXDATE;TZID=${TZ}:20261104T190000`,
    'SUMMARY:STAT 30100 Lecture',
    'LOCATION:LDPI 010',
    'END:VEVENT',
  ],
  [
    'BEGIN:VEVENT',
    'UID:stat30100-lecture@purdue.edu',
    `RECURRENCE-ID;TZID=${TZ}:20261109T190000`,
    `DTSTART;TZID=${TZ}:20261109T180000`,
    `DTEND;TZID=${TZ}:20261109T191500`,
    'SUMMARY:STAT 30100 Lecture',
    'LOCATION:LE 101',
    'END:VEVENT',
  ],
  // Thursday at 8:30 PM, the next day in UTC in both seasons, across the start
  // of EDT (14 March 2027).
  [
    'BEGIN:VEVENT',
    'UID:cs24000-lab@purdue.edu',
    `DTSTART;TZID=${TZ}:20270304T203000`,
    `DTEND;TZID=${TZ}:20270304T212000`,
    'RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=TH',
    'SUMMARY:CS 24000 Laboratory',
    'LOCATION:SLPI 010',
    'END:VEVENT',
  ],
)

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** "Mon 2026-11-02 19:00": an instant on the Indianapolis wall clock. */
function local(instant) {
  const p = Object.fromEntries(wallClock.formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

const SCHEDULE_SOURCE = { id: 'src-ut', user_id: 'user-1', source_type: 'purdue_schedule_ical', source_url: 'https://timetable.mypurdue.purdue.edu/Timetabling/export?x=1' }

test('an evening class stays on its own day through both daylight saving changes, with its cancellation and its move', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-12-01T12:00:00Z') })
  const plan = planSync(await ical.async.parseICS(EVENING_ICS), SCHEDULE_SOURCE)
  const items = [...plan.itemsToInsert].sort((a, b) => a.start_time.localeCompare(b.start_time))
  assert.deepEqual(
    items.map((item) => [local(item.start_time), local(item.end_time).slice(-5), item.title, item.location]),
    [
      ['Mon 2026-10-26 19:00', '20:15', 'STAT 30100 Lecture', 'LDPI 010'],
      ['Wed 2026-10-28 19:00', '20:15', 'STAT 30100 Lecture', 'LDPI 010'],
      ['Mon 2026-11-02 19:00', '20:15', 'STAT 30100 Lecture', 'LDPI 010'],
      // Wednesday 4 November is cancelled, and Monday 9 November moved.
      ['Mon 2026-11-09 18:00', '19:15', 'STAT 30100 Lecture', 'LE 101'],
      ['Wed 2026-11-11 19:00', '20:15', 'STAT 30100 Lecture', 'LDPI 010'],
      ['Thu 2027-03-04 20:30', '21:20', 'CS 24000 Laboratory', 'SLPI 010'],
      ['Thu 2027-03-11 20:30', '21:20', 'CS 24000 Laboratory', 'SLPI 010'],
      ['Thu 2027-03-18 20:30', '21:20', 'CS 24000 Laboratory', 'SLPI 010'],
    ],
  )
  // Each meeting is keyed by its own day, so a re-sync updates the same row.
  assert.deepEqual(items.slice(0, 3).map((item) => item.external_uid), [
    'stat30100-lecture@purdue.edu:2026-10-26',
    'stat30100-lecture@purdue.edu:2026-10-28',
    'stat30100-lecture@purdue.edu:2026-11-02',
  ])
})

test("cancelling an evening class leaves the next day's class alone", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-12-01T12:00:00Z') })
  // Monday and Tuesday at 8:30 PM with the first Monday cancelled. That
  // Monday's instant is Tuesday in UTC, so a match on the UTC day of the
  // exclusion would cancel Tuesday's class as well.
  const ics = feed([
    'BEGIN:VEVENT',
    'UID:engl10600-lecture@purdue.edu',
    `DTSTART;TZID=${TZ}:20261102T203000`,
    `DTEND;TZID=${TZ}:20261102T214500`,
    'RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,TU',
    `EXDATE;TZID=${TZ}:20261102T203000`,
    'SUMMARY:ENGL 10600 Lecture',
    'LOCATION:CA 331',
    'END:VEVENT',
  ])
  const plan = planSync(await ical.async.parseICS(ics), SCHEDULE_SOURCE)
  assert.deepEqual(
    plan.itemsToInsert.map((item) => local(item.start_time)).sort(),
    ['Mon 2026-11-09 20:30', 'Tue 2026-11-03 20:30', 'Tue 2026-11-10 20:30'],
  )
})

test('a morning class reads the same as before', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-12-01T12:00:00Z') })
  const lecture = Object.values(await ical.async.parseICS(ICS)).find((e) => e?.type === 'VEVENT' && String(e.uid).startsWith('lecture'))
  const out = expandRecurringEvents([lecture], TZ)
  assert.ok(out.length > 40, 'a year and more of Wednesdays')
  for (const occurrence of out) {
    assert.match(local(occurrence.start), /^Wed \d{4}-\d{2}-\d{2} 09:30$/, local(occurrence.start))
    assert.equal(occurrence.uid, `${lecture.uid}:${local(occurrence.start).slice(4, 14)}`)
  }
})
