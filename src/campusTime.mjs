// Clock helpers for the widget reads (issue #549): a wall-clock time on a
// campus date turned into an instant, and instants written the way the app's
// widget extension decodes them. Pure.

import { CAMPUS_TIME_ZONE } from './diningMeals.mjs'

/**
 * An instant as ISO 8601 in UTC to the second, with no fraction
 * ("2026-10-28T13:42:05Z"): Swift's JSONDecoder reads that with its
 * `.iso8601` strategy, which refuses the milliseconds toISOString writes.
 */
export function isoSeconds(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

/** YYYY-MM-DD `days` calendar days after `ymd` (negative goes back). */
export function plusDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

// How far `timeZone`'s wall clock is ahead of UTC at the instant `ms`
// (negative west of Greenwich: -4 h for Indianapolis in summer).
function zoneOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant at `minutes` past midnight on the campus date `ymd` (1440 is
 * the next midnight). The offset is read at the guess and again at the
 * answer, so a time on the day the clocks change lands on the right side.
 */
export function zonedTimeMs(ymd, minutes, timeZone = CAMPUS_TIME_ZONE) {
  const [y, m, d] = ymd.split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d, 0, minutes)
  const first = wall - zoneOffsetMs(wall, timeZone)
  return wall - zoneOffsetMs(first, timeZone)
}
