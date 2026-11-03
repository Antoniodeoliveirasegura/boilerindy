// The server's notification policy (issue #550, items 3 and 8): quiet hours,
// the evening digest, the 30-minute merge and the daily cap, all on the
// campus clock. Pure. The app keeps its own copy of these rules
// (src/lib/notification-policy.ts in boilerindy-app), and both are held to the
// test vectors in the kind registry (src/notificationKinds.mjs), so a phone and
// this server agree about the same night. Times are campus wall-clock minutes
// past midnight, never "now plus N hours": the nights the clocks change are 8
// and 10 hours long.

import { plusDaysYmd, zonedTimeMs } from './campusTime.mjs'
import { CAMPUS_TIME_ZONE, minutesInZone } from './diningMeals.mjs'
import { NOTIFICATION_KINDS } from './notificationKinds.mjs'

/** At most this many server pushes reach a student in a campus day, across the capped kinds. */
export const DAILY_CAP = NOTIFICATION_KINDS.dailyCap
/** The kinds the daily cap counts: the registry's `cap: 'daily'`. */
export const CAPPED_KINDS = Object.freeze(NOTIFICATION_KINDS.kinds.filter((kind) => kind.cap === 'daily').map((kind) => kind.id))
/** Deadlines due within this many minutes of each other go out as one notification. */
export const MERGE_MINUTES = NOTIFICATION_KINDS.kinds.find((kind) => kind.id === 'deadline').mergeMinutes
/** An all-day item is reminded at 9:00 AM on its day, as the app does. */
export const ALL_DAY_REMINDER_MINUTE = 9 * 60
/** The account defaults: quiet hours 11:00 PM to 8:00 AM, the evening list at 6:00 PM. */
export const DEFAULT_QUIET = Object.freeze({ ...NOTIFICATION_KINDS.quietHours })
export const DEFAULT_DIGEST_MINUTE = NOTIFICATION_KINDS.kinds.find((kind) => kind.id === 'deadline-digest').default.minute

const MINUTES_PER_DAY = 24 * 60

/** The campus date (YYYY-MM-DD) of the instant `ms`. */
export function campusYmd(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms),
  )
}

/** True for a whole minute of the day, 0 to 1439. */
export function isDayMinute(value) {
  return Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY
}

/**
 * Quiet hours as { start, end } in minutes past midnight, or null when they
 * are off: a null pair, or a start equal to its end (an empty window).
 */
export function quietWindow(start, end) {
  return isDayMinute(start) && isDayMinute(end) && start !== end ? { start, end } : null
}

/**
 * True when `minute` falls inside the window: from its start, up to but not
 * including its end. A window whose start comes after its end (11:00 PM to
 * 8:00 AM) wraps midnight.
 */
export function isQuietMinute(minute, window) {
  if (!window) return false
  return window.start < window.end ? minute >= window.start && minute < window.end : minute >= window.start || minute < window.end
}

/**
 * When the quiet hours around the instant `ms` end, as an instant, or null
 * when `ms` is not inside them. A notification held for quiet hours goes then,
 * if it is still true.
 */
export function quietEndsAt(ms, window) {
  if (!window) return null
  const minute = minutesInZone(new Date(ms))
  if (!isQuietMinute(minute, window)) return null
  const today = campusYmd(ms)
  const morning = window.start > window.end && minute >= window.start ? plusDaysYmd(today, 1) : today
  return zonedTimeMs(morning, window.end)
}

/**
 * The digest on the campus date `ymd` at `minute`: `at`, when it goes, and
 * `until`, the next day's digest, which ends what it lists. What is due after
 * `at` and up to `until` belongs to it, so no item falls between two digests
 * on a 23 or 25 hour day.
 */
export function digestWindow(ymd, minute) {
  return { at: zonedTimeMs(ymd, minute), until: zonedTimeMs(plusDaysYmd(ymd, 1), minute) }
}

/** The campus day around `ms`, as instants: from its midnight to the next. */
export function campusDay(ms) {
  const ymd = campusYmd(ms)
  return { ymd, start: zonedTimeMs(ymd, 0), end: zonedTimeMs(plusDaysYmd(ymd, 1), 0) }
}

/**
 * Items (each with a `dueAt` Date) in groups that go out as one notification:
 * sorted by due time, each group holding the items due within `minutes` of
 * its first. Three items due at 11:59 PM become one group.
 */
export function mergeByDue(items, minutes = MERGE_MINUTES) {
  const groups = []
  for (const item of [...items].sort((a, b) => a.dueAt - b.dueAt)) {
    const group = groups[groups.length - 1]
    if (group && item.dueAt - group[0].dueAt <= minutes * 60_000) group.push(item)
    else groups.push([item])
  }
  return groups
}
