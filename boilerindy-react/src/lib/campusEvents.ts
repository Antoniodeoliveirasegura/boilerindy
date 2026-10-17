// The shared campus events on the Events and Free Food pages (issue #30): the
// rows GET /api/me/calendar?shared=1 adds while the server's feed is on. They
// come from public campus calendars, not the student's own feed, so a page
// says where each one came from and links out to its listing.
//
// Campus listings can run for days (a gallery exhibit, a week-long fair), so
// both pages time every row by its end: a row is listed until it is over, and
// one still running from an earlier day is listed under today instead of
// under a date already gone.

/** What the two pages read off a calendar row for its timing and its source. */
export type CampusEventFields = {
  startTime: string
  endTime?: string | null
  allDay?: boolean
  shared?: boolean
  sourceLabel?: string
  sourceUrl?: string | null
}

type Timed = Pick<CampusEventFields, 'startTime' | 'endTime' | 'allDay'>

const DAY_MS = 24 * 60 * 60 * 1000

/** The listing a shared row links out to, and the host the link names; null without an http(s) link. */
export function listingLink(item: Pick<CampusEventFields, 'shared' | 'sourceUrl'>): { href: string; host: string } | null {
  if (!item.shared || !item.sourceUrl) return null
  try {
    const url = new URL(item.sourceUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return { href: url.toString(), host: url.hostname.replace(/^www\./, '') }
  } catch {
    return null
  }
}

// Its end; an all-day row with no end runs to the end of its day, as on the
// server and on Home; any other row ends when it starts.
function endMs(item: Timed): number {
  if (item.endTime) return new Date(item.endTime).getTime()
  const start = new Date(item.startTime).getTime()
  return item.allDay ? start + DAY_MS : start
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Over: past its end. */
export function hasEnded(item: Timed, now: Date = new Date()): boolean {
  return endMs(item) < now.getTime()
}

/** Started and not over yet. */
export function isOngoing(item: Timed, now: Date = new Date()): boolean {
  return new Date(item.startTime).getTime() <= now.getTime() && !hasEnded(item, now)
}

/** Started on an earlier day and still running. */
export function runsFromEarlierDay(item: Timed, now: Date = new Date()): boolean {
  return isOngoing(item, now) && new Date(item.startTime) < startOfDay(now)
}

/** The instant a row is listed and sorted at: its start, or now for one still running from an earlier day. */
export function listedTime(item: Timed, now: Date = new Date()): string {
  return runsFromEarlierDay(item, now) ? now.toISOString() : item.startTime
}

/**
 * "until 5:00 PM" when a row ends later today, "until Fri, Nov 14" when it
 * ends on a later day, and "ends today" at midnight tonight: an end at local
 * midnight closes the day before, as on Home.
 */
export function untilLabel(item: Timed, now: Date = new Date()): string {
  const end = new Date(endMs(item))
  const endsAtMidnight = end.getHours() === 0 && end.getMinutes() === 0
  const lastDay = endsAtMidnight ? new Date(end.getTime() - 1) : end
  if (lastDay.toDateString() === now.toDateString()) {
    return endsAtMidnight ? 'ends today' : `until ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  }
  return `until ${lastDay.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
}
