import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isoSeconds, plusDaysYmd, zonedTimeMs } from '../src/campusTime.mjs'

// Issue #549: the widget reads write times the app's extension decodes, and
// turn the dining halls' wall-clock hours into instants on the campus clock.

const iso = (ms) => new Date(ms).toISOString()

test('isoSeconds writes UTC to the second with no fraction', () => {
  assert.equal(isoSeconds(Date.parse('2026-10-28T12:42:05.789Z')), '2026-10-28T12:42:05Z')
  assert.equal(isoSeconds(Date.parse('2026-10-28T12:42:00Z')), '2026-10-28T12:42:00Z')
  assert.match(isoSeconds(Date.now()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('plusDaysYmd moves across months and years', () => {
  assert.equal(plusDaysYmd('2026-10-31', 1), '2026-11-01')
  assert.equal(plusDaysYmd('2026-01-01', -1), '2025-12-31')
  assert.equal(plusDaysYmd('2026-10-28', 7), '2026-11-04')
  assert.equal(plusDaysYmd('2028-02-28', 1), '2028-02-29')
})

test('zonedTimeMs reads a wall-clock time on the Indianapolis calendar, either side of a clock change', () => {
  // Daylight time: UTC-4.
  assert.equal(iso(zonedTimeMs('2026-10-28', 7 * 60)), '2026-10-28T11:00:00.000Z')
  assert.equal(iso(zonedTimeMs('2026-10-28', 21 * 60)), '2026-10-29T01:00:00.000Z')
  // 1440 is the next midnight.
  assert.equal(iso(zonedTimeMs('2026-10-28', 24 * 60)), '2026-10-29T04:00:00.000Z')
  // Standard time after the clocks go back at 2:00 AM on 2026-11-01: UTC-5.
  assert.equal(iso(zonedTimeMs('2026-11-01', 0)), '2026-11-01T04:00:00.000Z')
  assert.equal(iso(zonedTimeMs('2026-11-01', 12 * 60)), '2026-11-01T17:00:00.000Z')
  assert.equal(iso(zonedTimeMs('2026-11-02', 7 * 60)), '2026-11-02T12:00:00.000Z')
  // In the hours after the change, the offset at the first guess is the old
  // one, so the answer needs the second look.
  assert.equal(iso(zonedTimeMs('2026-11-01', 5 * 60)), '2026-11-01T10:00:00.000Z')
  // And forward again on 2027-03-14.
  assert.equal(iso(zonedTimeMs('2027-03-14', 5 * 60)), '2027-03-14T09:00:00.000Z')
  assert.equal(iso(zonedTimeMs('2027-03-14', 12 * 60)), '2027-03-14T16:00:00.000Z')
  // Another zone, for the record.
  assert.equal(iso(zonedTimeMs('2026-10-28', 9 * 60, 'Asia/Seoul')), '2026-10-28T00:00:00.000Z')
})
