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

import { detectTimezoneFromFeed, expandRecurringEvents, icalText } from '../src/scheduleSync.mjs'

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
