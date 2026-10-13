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

/**
 * 'Due in Nh' for an open item due within the next 24 hours, with the hours
 * rounded up and at least 1; null for a completed item, an overdue one, one
 * due later than a day from now, or a missing or unreadable due time.
 */
export function dueSoonLabel(
  due: Instant | null | undefined,
  { completed = false, now = Date.now() }: { completed?: boolean; now?: Instant } = {},
): string | null {
  if (completed || due === null || due === undefined || due === '') return null
  const msLeft = toMs(due) - toMs(now)
  if (!Number.isFinite(msLeft) || msLeft <= 0 || msLeft > DAY_MS) return null
  return `Due in ${Math.max(1, Math.ceil(msLeft / HOUR_MS))}h`
}
