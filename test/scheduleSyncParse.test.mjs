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
