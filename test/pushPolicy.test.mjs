import { test } from 'node:test'
import assert from 'node:assert/strict'

import { NOTIFICATION_KINDS } from '../src/notificationKinds.mjs'
import {
  CAPPED_KINDS,
  DAILY_CAP,
  DEFAULT_DIGEST_MINUTE,
  DEFAULT_QUIET,
  MERGE_MINUTES,
  campusDay,
  campusYmd,
  digestWindow,
  isQuietMinute,
  mergeByDue,
  quietEndsAt,
  quietWindow,
} from '../src/pushPolicy.mjs'

// The server's notification policy (issue #550, items 3 and 8), held to the
// test vectors the kind registry shares with the app: the nights of 2027 the
// campus clocks change are 8 and 10 hours long, and a digest day 23 or 25.

test('the numbers come from the kind registry', () => {
  assert.equal(DAILY_CAP, 6)
  assert.deepEqual(CAPPED_KINDS, ['deadline', 'deadline-digest', 'dining-favorites', 'room-change'])
  assert.equal(MERGE_MINUTES, 30)
  assert.deepEqual(DEFAULT_QUIET, { start: 23 * 60, end: 8 * 60 })
  assert.equal(DEFAULT_DIGEST_MINUTE, 18 * 60)
})

test("quiet hours pass the registry's vectors across both clock changes", () => {
  const { quietHours } = NOTIFICATION_KINDS.vectors
  const window = quietWindow(quietHours.start, quietHours.end)
  for (const c of quietHours.cases) {
    const endsAt = quietEndsAt(Date.parse(c.at), window)
    assert.equal(endsAt !== null, c.quiet, c.at)
    assert.equal(endsAt, c.endsAt === null ? null : Date.parse(c.endsAt), c.at)
  }
})

test("the digest passes the registry's vectors: each lists up to the next day's", () => {
  const { digest } = NOTIFICATION_KINDS.vectors
  for (const c of digest.cases) {
    assert.deepEqual(digestWindow(c.date, digest.minute), { at: Date.parse(c.at), until: Date.parse(c.until) }, c.date)
  }
})

test('quiet hours: off as a null pair or an empty window; a daytime window does not wrap', () => {
  assert.equal(quietWindow(null, null), null)
  assert.equal(quietWindow(600, 600), null)
  assert.equal(quietWindow(600, 1440), null)
  assert.equal(quietWindow(600, undefined), null)
  assert.equal(isQuietMinute(0, null), false)
  const daytime = quietWindow(13 * 60, 14 * 60)
  assert.deepEqual([12 * 60 + 59, 13 * 60, 13 * 60 + 59, 14 * 60].map((m) => isQuietMinute(m, daytime)), [false, true, true, false])
  // 1:30 PM EDT on 2026-09-08 is inside it, and the hours end at 2:00 PM that day.
  assert.equal(quietEndsAt(Date.parse('2026-09-08T17:30:00Z'), daytime), Date.parse('2026-09-08T18:00:00Z'))
  assert.equal(quietEndsAt(Date.parse('2026-09-08T18:00:00Z'), daytime), null)
})

test('mergeByDue groups what is due within 30 minutes of the group\'s first item', () => {
  const at = (hhmm) => ({ key: hhmm, dueAt: new Date(`2026-09-08T${hhmm}:00-04:00`) })
  const groups = mergeByDue([at('23:59'), at('23:30'), at('23:59'), at('22:00'), at('23:00'), at('22:31'), at('22:30')])
  assert.deepEqual(groups.map((group) => group.map((item) => item.key)), [['22:00', '22:30'], ['22:31', '23:00'], ['23:30', '23:59', '23:59']])
  assert.deepEqual(mergeByDue([]), [])
})

test('campusDay is midnight to midnight on the campus clock, 23 or 25 hours on the days the clocks change', () => {
  const hours = (ms) => {
    const day = campusDay(ms)
    return (day.end - day.start) / 3_600_000
  }
  assert.equal(hours(Date.parse('2026-09-08T14:00:00Z')), 24)
  assert.equal(hours(Date.parse('2027-03-14T15:00:00Z')), 23)
  assert.equal(hours(Date.parse('2027-11-07T15:00:00Z')), 25)
  // 11:30 PM EDT is still the 8th on campus, though it is the 9th in UTC.
  assert.equal(campusYmd(Date.parse('2026-09-09T03:30:00Z')), '2026-09-08')
  assert.equal(campusDay(Date.parse('2026-09-09T03:30:00Z')).start, Date.parse('2026-09-08T04:00:00Z'))
})
