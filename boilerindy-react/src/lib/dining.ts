// Client-side types and pure helpers for the Dining page (issue #119). The
// shapes mirror renderSnapshot() in src/nutrisliceDining.mjs on the server.

export type MenuItem = {
  name: string
  calories?: number | null
  icons?: string[]
  // The compact facts of issue #468, on per-meal menu items only; absent when the feed has none.
  id?: number
  serving?: string
  protein?: number
  carbs?: number
  fat?: number
  sodium?: number
  /** 220 px photo. */
  thumb?: string
  /** The description, cut for the list; the detail read has it whole. */
  desc?: string
}

/** GET /api/dining/foods/:id (issue #468): one dish, as the detail view shows it. */
export type DishDetail = {
  id: number
  name: string
  description: string | null
  image: string | null
  thumb: string | null
  serving: string | null
  ingredients: string | null
  icons: string[]
  nutrition: Record<string, number>
}
/** `everyday`: the station serves the same food all week (issue #466); absent means it changes. */
export type Station = { name: string; everyday?: boolean; items: MenuItem[] }
/** One meal's whole menu (issue #466). */
export type MealMenu = { meal: string; stations: Station[] }

// The single view for a snapshot from before per-meal menus, which only has
// every meal merged into `stations`.
export const ALL_MEALS = 'all'

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
  /** One whole menu per meal, in serving order (issue #466). */
  menus?: MealMenu[]
  /** Deprecated: every meal merged into one list; still read when `menus` is missing. */
  stations?: Station[]
  /** Whether the menu feed is being kept up (issue #467); null for a retail hall. */
  menu_source?: MenuSource | null
  warnings?: unknown
}

export type MenuSource = { last_updated?: string | null; stale?: boolean; reason?: 'empty_week' | 'not_updated' | null }

// The official menu, on Dine On Campus ("IU Indy Eats"). The Nutrislice site
// this page reads is deactivated, though its API still answers (issue #467).
export const OFFICIAL_MENU_URL = 'https://dineoncampus.com/iuindy/whats-on-the-menu'

/** What to tell a student when the hall's menu feed looks abandoned, or null when it does not. */
export function feedNotice(loc: Pick<DiningLocation, 'menu_source'>): string | null {
  const source = loc.menu_source
  if (!source?.stale) return null
  if (source.reason === 'empty_week') return 'No menu is posted for this week. The campus menu feed may have moved, so check the official menu.'
  const updated = source.last_updated ? new Date(source.last_updated) : null
  const since =
    updated && !Number.isNaN(updated.getTime())
      ? updated.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Indiana/Indianapolis' })
      : null
  return since
    ? `The campus menu feed has not been updated since ${since}, so this menu may be out of date.`
    : 'The campus menu feed has not been updated in weeks, so this menu may be out of date.'
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

/**
 * A location's meals: its per-meal menus, or, for a snapshot persisted from
 * before them, one ALL_MEALS view of the merged stations. Empty when nothing
 * is posted.
 */
export function locationMenus(loc: Pick<DiningLocation, 'menus' | 'stations'>): MealMenu[] {
  if (loc.menus && loc.menus.length) return loc.menus
  return loc.stations && loc.stations.length ? [{ meal: ALL_MEALS, stations: loc.stations }] : []
}

/** A meal's stations split into the ones that change day to day and the every-day ones, each in feed order. */
export function splitStations(stations: Station[]): { specials: Station[]; everyday: Station[] } {
  return { specials: stations.filter((s) => !s.everyday), everyday: stations.filter((s) => s.everyday) }
}

/** "Today's lunch" for a meal slug, "Today's menu" for anything else. */
export function todaysMealHeading(meal: string | null | undefined): string {
  return meal && ['breakfast', 'brunch', 'lunch', 'dinner'].includes(meal) ? `Today's ${meal}` : "Today's menu"
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

// ── Diet filters and dish details (issue #468) ─────────────────────────────

/**
 * The diet labels the menu can be filtered by: the feed's own names. They are
 * not allergen information, and the feed carries none, which the page says
 * next to them.
 */
export const DIET_FILTERS = ['Vegetarian', 'Vegan', 'Avoiding Gluten'] as const
export type DietFilter = (typeof DIET_FILTERS)[number]

export const DIET_LABEL_NOTE =
  'Diet labels come from the dining menu feed. They are not allergen information: the feed lists no allergens, so ask dining staff about allergies.'

/** The stations with only the items that carry every chosen label; stations left empty are dropped. */
export function filterStations(stations: Station[], filters: readonly string[]): Station[] {
  if (!filters.length) return stations
  return stations
    .map((station) => ({ ...station, items: station.items.filter((item) => filters.every((f) => item.icons?.includes(f))) }))
    .filter((station) => station.items.length > 0)
}

// Per device, not per user: the page is public (signed-out visitors filter
// too), and a diet label is a preference, not account data.
export const DIET_FILTERS_KEY = 'boilerindy-dining-diet-filters-v1'

/** The saved filters, or none when storage is missing, throws or holds anything unexpected. */
export function readDietFilters(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): DietFilter[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DIET_FILTERS_KEY) ?? '[]')
    return Array.isArray(parsed) ? DIET_FILTERS.filter((f) => parsed.includes(f)) : []
  } catch {
    return []
  }
}

export function writeDietFilters(filters: readonly string[], storage: Pick<Storage, 'setItem'> | null = safeLocalStorage()): void {
  try {
    storage?.setItem(DIET_FILTERS_KEY, JSON.stringify(DIET_FILTERS.filter((f) => filters.includes(f))))
  } catch {
    // Private mode or a full quota: the filter still works for this visit.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export type NutritionRow = { key: string; label: string; value: string }

// Nutrislice's keys, in label order, with the units the feed uses. Values are
// shown as published; some rows are implausible, so nothing ranks dishes by them.
const NUTRITION_FACTS: { key: string; label: string; unit: string; minor?: boolean }[] = [
  { key: 'calories', label: 'Calories', unit: '' },
  { key: 'g_fat', label: 'Total fat', unit: 'g' },
  { key: 'g_saturated_fat', label: 'Saturated fat', unit: 'g' },
  { key: 'g_trans_fat', label: 'Trans fat', unit: 'g' },
  { key: 'mg_cholesterol', label: 'Cholesterol', unit: 'mg' },
  { key: 'mg_sodium', label: 'Sodium', unit: 'mg' },
  { key: 'g_carbs', label: 'Carbohydrates', unit: 'g' },
  { key: 'g_fiber', label: 'Fiber', unit: 'g' },
  { key: 'g_sugar', label: 'Sugars', unit: 'g' },
  { key: 'g_added_sugar', label: 'Added sugars', unit: 'g' },
  { key: 'g_protein', label: 'Protein', unit: 'g' },
  { key: 'mg_potassium', label: 'Potassium', unit: 'mg', minor: true },
  { key: 'mg_calcium', label: 'Calcium', unit: 'mg', minor: true },
  { key: 'mg_iron', label: 'Iron', unit: 'mg', minor: true },
  { key: 'iu_vitamin_a', label: 'Vitamin A', unit: 'IU', minor: true },
  { key: 'mg_vitamin_c', label: 'Vitamin C', unit: 'mg', minor: true },
  { key: 'mcg_vitamin_d', label: 'Vitamin D', unit: 'mcg', minor: true },
]

function formatAmount(value: number, unit: string): string {
  const rounded = Math.round(value * 10) / 10
  return unit ? `${rounded} ${unit}` : String(rounded)
}

/** The nutrition table: the main facts, then vitamins and minerals, only the values the feed has. */
export function nutritionRows(nutrition: Record<string, number> | null | undefined): { main: NutritionRow[]; minor: NutritionRow[] } {
  const rows = { main: [] as NutritionRow[], minor: [] as NutritionRow[] }
  for (const fact of NUTRITION_FACTS) {
    const value = nutrition?.[fact.key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    rows[fact.minor ? 'minor' : 'main'].push({ key: fact.key, label: fact.label, value: formatAmount(value, fact.unit) })
  }
  return rows
}

/** "Protein 17 g · Carbs 0 g · Fat 13 g · Sodium 53 mg" from an item's compact facts, or '' when it has none. */
export function macroLine(item: Pick<MenuItem, 'protein' | 'carbs' | 'fat' | 'sodium'>): string {
  const parts: string[] = []
  if (item.protein != null) parts.push(`Protein ${formatAmount(item.protein, 'g')}`)
  if (item.carbs != null) parts.push(`Carbs ${formatAmount(item.carbs, 'g')}`)
  if (item.fat != null) parts.push(`Fat ${formatAmount(item.fat, 'g')}`)
  if (item.sodium != null) parts.push(`Sodium ${formatAmount(item.sodium, 'mg')}`)
  return parts.join(' · ')
}

// ── What is coming up (issue #469) ─────────────────────────────────────────

export type Headliner = { name: string; image: string | null }
export type UpcomingMeal = { meal: string; location: string; headliners: Headliner[]; specials: string[] }
export type UpcomingDay = { date: string; tentative: boolean; holiday: string | null; meals: UpcomingMeal[] }
/** GET /api/dining/upcoming. */
export type DiningUpcoming = { ok?: boolean; today?: string; days?: UpcomingDay[] }

/** The headline dishes for `date` and `meal`, from the digest; [] on weekends and days it does not cover. */
export function headlinersFor(upcoming: DiningUpcoming | null | undefined, date: string | null | undefined, meal: string | null | undefined): Headliner[] {
  const day = upcoming?.days?.find((d) => d.date === date)
  return day?.meals.filter((m) => m.meal === meal).flatMap((m) => m.headliners) ?? []
}

export type FavoriteComingUp = { name: string; date: string; meal: string; location: string; tentative: boolean }

/**
 * For each favorite (normalized names), its next appearance after `today` in
 * the look-ahead, headliners and specials alike, soonest first. Today's
 * favorites have their own card, so they are not repeated here.
 */
export function favoritesComingUp(
  favorites: Iterable<string>,
  upcoming: DiningUpcoming | null | undefined,
  today: string | null | undefined,
  normalize: (name: string) => string,
): FavoriteComingUp[] {
  const wanted = new Set(favorites)
  if (!wanted.size || !upcoming?.days?.length || !today) return []
  const found = new Map<string, FavoriteComingUp>()
  for (const day of upcoming.days) {
    if (day.date <= today) continue
    for (const meal of day.meals) {
      for (const name of [...meal.headliners.map((h) => h.name), ...meal.specials]) {
        const key = normalize(name)
        if (!wanted.has(key) || found.has(key)) continue
        found.set(key, { name, date: day.date, meal: meal.meal, location: meal.location, tentative: day.tentative })
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

const DAY_MS = 24 * 60 * 60 * 1000

function ymdUtc(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/**
 * "Jamaican Jerk Chicken is back tomorrow" / "... is back Thursday" within a
 * week, "Butter Chicken: Thu, Nov 19 (tentative)" beyond it, where the menu
 * is still a draft.
 */
export function comingUpLine(entry: Pick<FavoriteComingUp, 'name' | 'date' | 'tentative'>, today: string): string {
  const days = Math.round((ymdUtc(entry.date) - ymdUtc(today)) / DAY_MS)
  const date = new Date(ymdUtc(entry.date))
  if (days === 1) return `${entry.name} is back tomorrow`
  if (days > 1 && days <= 7 && !entry.tentative) return `${entry.name} is back ${date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}`
  const label = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${entry.name}: ${label}${entry.tentative ? ' (tentative)' : ''}`
}
