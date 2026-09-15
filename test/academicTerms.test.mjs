import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLASS_SCAN_LOOKBACK_MONTHS,
  classScanFrom,
  compareTermKeys,
  getAcademicTerm,
  getPreferredClassTerm,
  parseTermKey,
} from '../src/academicTerms.mjs'
import { fetchAllPages } from '../src/pagedSelect.mjs'

// Issue #198: the class scan behind /api/me/classes read the user's class rows
// oldest first in one query, and PostgREST's 1000-row cap dropped everything
// after the first 1000 meetings, so the term pick ran on old semesters. All
// dates here are built in local time, the way getAcademicTerm reads them, and
// `now` is injected so nothing depends on the wall clock.

const HOUR_MS = 60 * 60 * 1000

// `count` 50-minute meetings starting at `start`, one every `stepHours`.
function meetings(start, count, stepHours) {
  return Array.from({ length: count }, (_, i) => {
    const begin = new Date(start.getTime() + i * stepHours * HOUR_MS)
    const end = new Date(begin.getTime() + 50 * 60 * 1000)
    return { start_time: begin.toISOString(), end_time: end.toISOString() }
  })
}

// 1200 rows, oldest first, across three terms: Spring 2026 (Jan 12 to late
// April), Summer 2026 (Jun 1 to mid July) and Fall 2026 (Aug 24 to early Dec).
function threeTermsOfClasses() {
  return [
    ...meetings(new Date(2026, 0, 12, 9, 30), 500, 5),
    ...meetings(new Date(2026, 5, 1, 9, 30), 500, 2),
    ...meetings(new Date(2026, 7, 24, 9, 30), 200, 12),
  ]
}

const MID_FALL_2026 = new Date(2026, 8, 15, 12, 0)

test('getAcademicTerm maps months to spring, summer and fall', () => {
  assert.equal(getAcademicTerm(new Date(2026, 0, 1)).key, '2026-spring')
  assert.equal(getAcademicTerm(new Date(2026, 4, 31)).key, '2026-spring')
  assert.equal(getAcademicTerm(new Date(2026, 5, 1)).key, '2026-summer')
  assert.equal(getAcademicTerm(new Date(2026, 6, 31)).key, '2026-summer')
  assert.equal(getAcademicTerm(new Date(2026, 7, 1)).key, '2026-fall')
  assert.deepEqual(getAcademicTerm(new Date(2026, 11, 31)), {
    key: '2026-fall',
    year: 2026,
    season: 'fall',
    label: 'Fall 2026',
  })
  assert.equal(getAcademicTerm('not a date'), null)
})

test('parseTermKey accepts only year-season keys', () => {
  assert.deepEqual(parseTermKey('2025-summer'), { key: '2025-summer', year: 2025, season: 'summer', label: 'Summer 2025' })
  assert.equal(parseTermKey('2025-winter'), null)
  assert.equal(parseTermKey('fall'), null)
  assert.equal(parseTermKey(null), null)
})

test('compareTermKeys orders by year, then spring < summer < fall', () => {
  const keys = ['2026-fall', '2025-fall', '2026-spring', 'junk', '2026-summer']
  assert.deepEqual([...keys].sort(compareTermKeys), ['junk', '2025-fall', '2026-spring', '2026-summer', '2026-fall'])
})

test('1200 class rows across three terms, paged past the 1000-row cap, still select the current term', async () => {
  const rows = threeTermsOfClasses()
  assert.equal(rows.length, 1200)

  // The server returns at most 1000 rows per response, whatever range is asked.
  const makeQuery = () => ({
    range: (from, to) => Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null }),
  })

  // Old behaviour: one capped response holds only spring and summer, and the
  // pick lands on a term that ended two months ago.
  const truncated = rows.slice(0, 1000)
  assert.equal(getPreferredClassTerm(truncated, { now: MID_FALL_2026 }).key, '2026-summer')

  const { data, error } = await fetchAllPages(makeQuery)
  assert.equal(error, null)
  assert.equal(data.length, 1200)
  assert.deepEqual(getPreferredClassTerm(data, { now: MID_FALL_2026 }), parseTermKey('2026-fall'))
})

test('the scan window keeps every meeting of the term it selects', () => {
  const rows = threeTermsOfClasses()
  const from = classScanFrom('auto', { now: MID_FALL_2026 })
  const windowed = rows.filter((row) => row.start_time >= from)
  const fall = rows.filter((row) => getAcademicTerm(row.start_time).key === '2026-fall')

  assert.equal(getPreferredClassTerm(windowed, { now: MID_FALL_2026 }).key, '2026-fall')
  assert.equal(windowed.filter((row) => getAcademicTerm(row.start_time).key === '2026-fall').length, fall.length)
})

test('with no meetings left this term, the soonest upcoming term wins', () => {
  const rows = [
    ...meetings(new Date(2026, 0, 12, 9, 30), 50, 48),
    ...meetings(new Date(2026, 7, 24, 9, 30), 50, 48),
  ]
  // Mid June: summer has no rows, spring is over, fall is ahead.
  assert.equal(getPreferredClassTerm(rows, { now: new Date(2026, 5, 15) }).key, '2026-fall')
})

test('with nothing current or upcoming, the latest term on record wins', () => {
  const rows = [
    ...meetings(new Date(2025, 7, 25, 9, 30), 50, 48),
    ...meetings(new Date(2026, 0, 12, 9, 30), 50, 48),
  ]
  assert.equal(getPreferredClassTerm(rows, { now: new Date(2026, 6, 20) }).key, '2026-spring')
  assert.equal(getPreferredClassTerm([], { now: new Date(2026, 6, 20) }), null)
})

test('classScanFrom reaches back CLASS_SCAN_LOOKBACK_MONTHS from the start of today', () => {
  const from = new Date(classScanFrom('auto', { now: MID_FALL_2026 }))
  assert.equal(CLASS_SCAN_LOOKBACK_MONTHS, 8)
  assert.equal(from.getTime(), new Date(2026, 0, 15).getTime())
  assert.equal(classScanFrom('all', { now: MID_FALL_2026 }), from.toISOString())
  assert.equal(classScanFrom('garbage', { now: MID_FALL_2026 }), from.toISOString())
})

test('classScanFrom covers the whole current term and reaches into the previous one on any day', () => {
  const firstMonth = { spring: 0, summer: 5, fall: 7 }
  for (let month = 0; month < 12; month += 1) {
    const now = new Date(2026, month, 28, 8, 0)
    const from = new Date(classScanFrom('auto', { now }))
    const current = getAcademicTerm(now)
    const currentStart = new Date(current.year, firstMonth[current.season], 1)
    // Strictly before the current term's first day, so the previous term's
    // latest meetings are in view too.
    assert.ok(from < currentStart, `month ${month + 1}: the window starts inside ${current.key}`)
  }
})

test('an explicit older term widens the window back to that term, a recent one does not', () => {
  const autoFrom = classScanFrom('auto', { now: MID_FALL_2026 })
  assert.equal(classScanFrom('2024-fall', { now: MID_FALL_2026 }), new Date(2024, 7, 1).toISOString())
  assert.equal(classScanFrom('2025-summer', { now: MID_FALL_2026 }), new Date(2025, 5, 1).toISOString())
  assert.equal(classScanFrom('2026-summer', { now: MID_FALL_2026 }), autoFrom)
  assert.equal(classScanFrom('2026-fall', { now: MID_FALL_2026 }), autoFrom)
})
