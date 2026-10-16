// The amber "Due in 15h" badge on an urgent task row (Home's Tasks due card and
// the Assignments list). Urgent means open and due within the next 24 hours.
// An overdue item is not "due in" anything, so it gets no label; a page that
// marks overdue items does so on its own ("Past due" on Assignments).
//
// The badge is decorative (aria-hidden on both pages): the row already says
// when the item is due.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

type Instant = string | number | Date

function toMs(value: Instant): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime()
}

type DueOptions = { completed?: boolean; now?: Instant }

/**
 * Whole hours until an open item due within the next 24 hours, rounded up and
 * at least 1; null for a completed item, an overdue one, one due later than a
 * day from now, or a missing or unreadable due time. Home's Heads up uses it
 * too: it used to round to the nearest hour, so one task read "due in 15h"
 * there and "Due in 16h" on its row, and "due in 0h" in its last half hour.
 */
export function dueSoonHours(
  due: Instant | null | undefined,
  { completed = false, now = Date.now() }: DueOptions = {},
): number | null {
  if (completed || due === null || due === undefined || due === '') return null
  const msLeft = toMs(due) - toMs(now)
  if (!Number.isFinite(msLeft) || msLeft <= 0 || msLeft > DAY_MS) return null
  return Math.max(1, Math.ceil(msLeft / HOUR_MS))
}

/** 'Due in Nh' for the hours dueSoonHours gives, or null. */
export function dueSoonLabel(due: Instant | null | undefined, options: DueOptions = {}): string | null {
  const hours = dueSoonHours(due, options)
  return hours === null ? null : `Due in ${hours}h`
}
