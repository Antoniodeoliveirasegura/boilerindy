// Calendar-date helpers that stay in the browser's local time zone.
//
// Date#toISOString() renders the UTC instant, so slicing its first ten
// characters yields the UTC calendar date, not the user's. East of UTC (the
// owner runs on KST, UTC+9) that is still yesterday until 09:00 local; west of
// it (Indianapolis, UTC-4/-5) it is already tomorrow from 19:00 or 20:00 local.
// Anything that fills an <input type="date"> or keys a per-day cache must build
// the string from local date parts instead.

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD` for `date` in the local time zone. Defaults to today. */
export function localIsoDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * The Monday of the local week containing `date` (Sunday belongs to the week
 * that began six days earlier). Time of day is preserved and the argument is
 * left untouched; callers that want a key pass the result to localIsoDate().
 */
export function startOfWeek(date: Date = new Date()): Date {
  const day = date.getDay()
  const monday = new Date(date)
  monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1))
  return monday
}
