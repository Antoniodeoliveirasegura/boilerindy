// Client-side types and pure helpers for the Dining page (issue #119). The
// shapes mirror renderSnapshot() in src/nutrisliceDining.mjs on the server.

export type MenuItem = { name: string; calories?: number | null; icons?: string[] }
export type Station = { name: string; items: MenuItem[] }

export type DiningLocation = {
  id: string
  slug: string
  name: string
  kind?: 'dining-hall' | 'retail'
  address?: string | null
  /** null: not known, a day the feed flags closed that has a published menu (issue #465). */
  is_open?: boolean | null
  hours?: string
  closes_at?: string | null
  opens_at?: string | null
  open24h?: boolean
  weekly_hours?: Record<string, string> | null
  meal?: string
  menusPublished?: boolean
  stations?: Station[]
  warnings?: unknown
}

export type DiningSnapshot = {
  ok?: boolean
  error?: string
  locations?: DiningLocation[]
  date?: string
  weekday?: string
  cached?: boolean
  stale?: boolean
}

export const WEEKDAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const SHORT_DAY: Record<string, string> = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
  Sunday: 'Sun',
}

// The server's value for a day the feed flags closed but that has a published
// menu (HOURS_NOT_LISTED in src/nutrisliceDining.mjs, issue #465). The weekend
// flags in the feed are wrong for Tower, and its weekday hours look like
// placeholders, so the page links the official hours page.
export const HOURS_NOT_LISTED = 'Hours not listed'
export const OFFICIAL_HOURS_URL = 'https://dineoncampus.com/iuindy/hours-of-operation'

export type OpenState = 'open' | 'closed' | 'unknown'

/** Open, closed, or not known (`is_open: null`), which must never read as either. */
export function openState(loc: Pick<DiningLocation, 'is_open'>): OpenState {
  if (loc.is_open === true) return 'open'
  return loc.is_open === null ? 'unknown' : 'closed'
}

/** The status-dot class: green open, red closed, neutral when not known. */
export function statusDotClass(loc: Pick<DiningLocation, 'is_open'>): string {
  const state = openState(loc)
  return state === 'open' ? 'status-open' : state === 'unknown' ? 'status-unknown' : 'status-closed'
}

/** "Open now, until 9:00 PM" / "Open 24 hours" / "Closed, opens 7:00 AM" / "Closed today" / "Menu posted, hours not listed". */
export function statusLine(loc: Pick<DiningLocation, 'is_open' | 'hours' | 'closes_at' | 'opens_at' | 'open24h'>): string {
  if (loc.is_open) {
    if (loc.open24h) return 'Open 24 hours'
    return loc.closes_at ? `Open now · until ${loc.closes_at}` : 'Open now'
  }
  if (loc.is_open === null) return 'Menu posted · hours not listed'
  if (loc.hours === 'Closed today') return 'Closed today'
  return loc.opens_at ? `Closed · opens ${loc.opens_at}` : 'Closed'
}

/** One day of the weekly grid: what to print and whether it is the muted style. */
export function weeklyHoursCell(hours: string | null | undefined): { label: string; muted: boolean } {
  if (!hours) return { label: 'Not posted', muted: false }
  if (hours === HOURS_NOT_LISTED) return { label: 'Not listed', muted: true }
  if (/closed/i.test(hours)) return { label: 'Closed', muted: true }
  return { label: hours, muted: false }
}

export type EmptyMenuState = { kind: 'retail' | 'no-menu'; icon: string; title: string; body: string }

/** What to say instead of a station grid. A retail hall is not "broken". */
export function emptyMenuState(loc: Pick<DiningLocation, 'kind' | 'name'>): EmptyMenuState {
  if (loc.kind === 'retail') {
    return {
      kind: 'retail',
      icon: 'building',
      title: 'Food court and retail vendors',
      body: `${loc.name} vendors serve from their own counters, so there is no daily menu to post here. Hours are above.`,
    }
  }
  return {
    kind: 'no-menu',
    icon: 'dining',
    title: 'No menu posted for today',
    body: `${loc.name} usually posts breakfast, lunch and dinner. Check back closer to meal time.`,
  }
}

/** Google Maps directions to the hall by its street address, or by name as a fallback. */
export function diningDirectionsUrl(loc: Pick<DiningLocation, 'address' | 'name'>): string {
  const destination = loc.address && loc.address.trim() ? loc.address.trim() : `${loc.name}, Indianapolis, IN`
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`
}

/**
 * The weekday to highlight. The snapshot carries the Indianapolis calendar day
 * it was built for; the browser's own day is only a fallback, because a
 * student (or the owner, on KST) can be on a different date from campus.
 */
export function snapshotWeekday(snapshot: Pick<DiningSnapshot, 'weekday'> | null | undefined, now: Date = new Date()): string {
  if (snapshot?.weekday && WEEKDAY_ORDER.includes(snapshot.weekday)) return snapshot.weekday
  return now.toLocaleDateString('en-US', { weekday: 'long' })
}

/** "Today: 7:00 AM - 9:00 PM · Menus: breakfast, lunch, dinner" for the header pill. */
export function headerBlurb(loc: Pick<DiningLocation, 'hours' | 'weekly_hours' | 'meal'>, weekday: string): string {
  const today = loc.weekly_hours?.[weekday] || loc.hours || 'Hours not posted'
  return `Today: ${today}${loc.meal ? ` · ${loc.meal}` : ''}`
}
