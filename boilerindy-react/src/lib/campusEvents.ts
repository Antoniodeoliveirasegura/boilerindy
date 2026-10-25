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
  sourceKey?: string
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

// ── Where a row came from: the source pills ─────────────────────────────────

/** A row's school on the source pills of Events and Free Food; `mine` is the student's own calendar. */
export type EventSource = 'purdue' | 'iu' | 'downtown' | 'mine'
export type SourceFilter = 'all' | EventSource
export type EventSourceCount = { id: EventSource; label: string; count: number }

// The shared rows' sourceKey (SOURCES in src/sharedEvents.mjs) by school:
// Purdue's calendar and BoilerLink are Purdue's, IU's calendar and TheSpot IU's.
// White River State Park's calendar is no school's: its rows are downtown
// (issue #30), with a pill of their own so a museum night never reads as a
// campus event.
const SCHOOL_BY_SOURCE_KEY: Record<string, EventSource> = {
  purdue_events: 'purdue',
  boilerlink: 'purdue',
  iu_events: 'iu',
  thespot: 'iu',
  wrsp_events: 'downtown',
}
const EVENT_SOURCE_ORDER: EventSource[] = ['purdue', 'iu', 'downtown', 'mine']
export const EVENT_SOURCE_LABEL: Record<EventSource, string> = { purdue: 'Purdue', iu: 'IU', downtown: 'Downtown', mine: 'My calendar' }

type Sourced = Pick<CampusEventFields, 'shared' | 'sourceKey'>

/** The row's school; null for a shared row from a source not listed above, which only "All sources" shows. */
export function eventSourceOf(item: Sourced): EventSource | null {
  if (!item.shared) return 'mine'
  return SCHOOL_BY_SOURCE_KEY[item.sourceKey ?? ''] ?? null
}

/** A shared row from a downtown source: the server lists it as a campus_event, but it is not one. */
export function isDowntownEvent(item: Sourced): boolean {
  return eventSourceOf(item) === 'downtown'
}

/** A pill per source the rows come from, in a fixed order; none while no row is shared. */
export function eventSourceCounts(items: Sourced[]): EventSourceCount[] {
  if (!items.some((item) => item.shared)) return []
  const counts = new Map<EventSource, number>()
  for (const item of items) {
    const source = eventSourceOf(item)
    if (source) counts.set(source, (counts.get(source) ?? 0) + 1)
  }
  return EVENT_SOURCE_ORDER.filter((id) => counts.has(id)).map((id) => ({ id, label: EVENT_SOURCE_LABEL[id], count: counts.get(id) ?? 0 }))
}

/**
 * The filter in force. The pills show only for two sources or more, so a pick
 * whose source has no rows left, or a single source, reads as all: the page
 * never strands on an empty list with no pill to undo it.
 */
export function activeSourceFilter(filter: SourceFilter, counts: EventSourceCount[]): SourceFilter {
  return filter !== 'all' && counts.length > 1 && counts.some((source) => source.id === filter) ? filter : 'all'
}

export function matchesSourceFilter(item: Sourced, filter: SourceFilter): boolean {
  return filter === 'all' || eventSourceOf(item) === filter
}
