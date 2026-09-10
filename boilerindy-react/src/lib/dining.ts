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
  is_open?: boolean
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

/** "Open now, until 9:00 PM" / "Open 24 hours" / "Closed, opens 7:00 AM" / "Closed today". */
export function statusLine(loc: Pick<DiningLocation, 'is_open' | 'hours' | 'closes_at' | 'opens_at' | 'open24h'>): string {
  if (loc.is_open) {
    if (loc.open24h) return 'Open 24 hours'
    return loc.closes_at ? `Open now · until ${loc.closes_at}` : 'Open now'
  }
  if (loc.hours === 'Closed today') return 'Closed today'
  return loc.opens_at ? `Closed · opens ${loc.opens_at}` : 'Closed'
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
