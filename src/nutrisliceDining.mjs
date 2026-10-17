/**
 * IU Indianapolis / IUPUI dining via the Nutrislice JSON API (issue #119).
 *
 * HTML lives on {district}.nutrislice.com; JSON is on
 * {district}.api.nutrislice.com with ?format=json. The district is
 * env-configurable (NUTRISLICE_API_BASE). The iupui district exposes exactly
 * two locations, both IU-operated and shared with Purdue in Indianapolis
 * students: Tower Dining (posts breakfast, lunch and dinner) and the Campus
 * Center (a retail food court that publishes no menu, only hours). See
 * docs/dining.md for the source decision and the payload contract.
 *
 * Shape: a pure core (raw Nutrislice rows in, normalized locations out, with
 * the open/closed rule), a fetch shell with an injectable fetch, and a
 * per-date cache that holds the expensive part (schools + menus) for hours,
 * with one upstream crawl at a time per date, while the open/closed status is
 * recomputed on every read, so "Open now" is never hours stale.
 */

import { sortMeals } from './diningMeals.mjs'

export const DEFAULT_API_BASE = 'https://iupui.api.nutrislice.com'
export const FALLBACK_TZ = 'America/Indiana/Indianapolis'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 18_000
const DEFAULT_CACHE_MS = 12 * 60 * 60 * 1000
// A failed refresh is remembered briefly, so an outage costs one upstream
// attempt every few minutes instead of one per page view, while the last good
// snapshot keeps serving.
export const FAILURE_RETRY_MS = 5 * 60 * 1000
// `?refresh=1` is public, so it is only a hint: a date is refetched on request
// at most once per this interval, however many clients ask (issue #208).
export const MIN_REFRESH_INTERVAL_MS = 10 * 60 * 1000
// Dates cached at once. The route's date window (yesterday to today + 14) is
// 16 days, so every date a client may ask for fits.
export const MAX_CACHE_DATES = 16
// The window itself, in days from today on the Indianapolis calendar.
const DATE_WINDOW_PAST_DAYS = 1
const DATE_WINDOW_FUTURE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000
// Weeks cached at once (issue #467), per school, meal and week. The 16-date
// window touches at most four weeks, times three meals, with room to spare.
export const MAX_CACHE_WEEKS = 24
// The feed counts as not updated once the newest `last_updated` across a
// hall's meals for the week is this old. The timestamp is a bulk one (every
// published lunch week carries the same value) and breakfast is republished
// rarely, so it is judged on the newest meal and with a long margin: the
// published horizon is about six weeks.
export const STALE_FEED_DAYS = 28
export const OFFICIAL_MENU_URL = 'https://dineoncampus.com/iuindy/whats-on-the-menu'

// The two halls the iupui district publishes. Nutrislice carries no address or
// coordinates for them, so the street addresses (for the directions link) are
// kept here. `kind` is derived from the API (a location with an explicit empty
// menu-type list is retail), so it moves if the district ever posts a menu.
export const LOCATION_FILTERS = [
  {
    id: 'tower-dining',
    label: 'Tower Dining',
    address: 'University Tower, 911 W North St, Indianapolis, IN 46202',
    test: (s) => /\btower\b/i.test(s.name || '') && /\bdining\b/i.test(s.name || ''),
  },
  {
    id: 'campus-center',
    label: 'Campus Center',
    address: '420 University Blvd, Indianapolis, IN 46202',
    test: (s) => /\bcampus\s*center\b/i.test(s.name || ''),
  },
]

// Only used when a school row carries no active_menu_types field at all
// (older districts). An explicit empty list means the location publishes no
// menus, and nothing is probed for it.
const FALLBACK_MEAL_SLUGS = ['breakfast', 'lunch', 'dinner', 'everyday']

const DAY_PREFIXES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const RETAIL_MENU_NOTE = 'Retail dining, no posted menu'
export const NO_MENU_NOTE = 'Menu not posted yet'
// A day the feed flags closed but that carries a published menu (issue #465):
// Tower publishes full weekend menus while its school row says Saturday and
// Sunday are closed, so the honest answer is "no hours listed", not Closed.
export const HOURS_NOT_LISTED = 'Hours not listed'

// Schools + menus per Indianapolis date (YYYY-MM-DD -> entry), and the crawl
// running for a date, so concurrent misses share it. A snapshot for another
// date no longer evicts today's (issue #208).
const entries = new Map()
const inFlight = new Map()
// Processed menu weeks per "slug|meal|Sunday" (issue #467), and the fetch
// running for one, so the seven dates of a week share one download per meal.
const weeks = new Map()
const weekFetches = new Map()

function apiBase() {
  return (process.env.NUTRISLICE_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '')
}

function cacheMs() {
  const n = Number(process.env.NUTRISLICE_CACHE_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_MS
}

// ── Clock helpers (pure) ────────────────────────────────────────────────────

function dayIndexInZone(date, timeZone) {
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date).toLowerCase().slice(0, 3)
  const idx = DAY_PREFIXES.indexOf(short)
  return idx === -1 ? 1 : idx
}

export function weekdayInZone(date, timeZone = FALLBACK_TZ) {
  return DAY_LABELS[dayIndexInZone(date, timeZone)]
}

export function wallClockMinutesInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

export function parseTimeToMinutes(clock) {
  if (!clock || typeof clock !== 'string') return null
  const [h, m] = clock.split(':').map((x) => Number(x))
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

export function formatClock12(clock) {
  const mins = parseTimeToMinutes(clock)
  if (mins == null) return ''
  let h = Math.floor(mins / 60) % 24
  const m = mins % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`
}

export function todayYmdInZone(date, timeZone = FALLBACK_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const y = parts.find((p) => p.type === 'year')?.value
  const mo = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  if (!y || !mo || !d) return null
  return `${y}-${mo}-${d}`
}

function ymdParts(ymd) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(ymd || '')
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

/**
 * The Sunday that starts the week of a YYYY-MM-DD date. Nutrislice serves
 * weeks Sunday to Saturday whatever day of them is asked for (checked
 * 2026-10-17: a request for Sunday 2026-10-18 answered 10-18 to 10-24).
 */
export function weekStartYmd(ymd) {
  const p = ymdParts(ymd)
  if (!p) return null
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day))
  date.setUTCDate(date.getUTCDate() - date.getUTCDay())
  return date.toISOString().slice(0, 10)
}

/** Long weekday name for a YYYY-MM-DD calendar date, independent of any zone. */
export function weekdayForYmd(ymd) {
  const p = ymdParts(ymd)
  if (!p) return null
  return DAY_LABELS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]
}

/**
 * Checks a `?date=YYYY-MM-DD` against the snapshot window: yesterday through
 * today + 14, counted on the Indianapolis calendar (issue #208). Returns
 * { ok: true, ymd } for a real calendar date inside it, { ok: false } for
 * anything else (bad format, 2026-13-01, 2026-02-30, out of range).
 */
export function clampDiningDate(dateStr, now = new Date()) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { ok: false }
  const p = ymdParts(dateStr)
  const wantMs = Date.UTC(p.year, p.month - 1, p.day)
  const check = new Date(wantMs)
  if (check.getUTCFullYear() !== p.year || check.getUTCMonth() !== p.month - 1 || check.getUTCDate() !== p.day) {
    return { ok: false }
  }
  const today = ymdParts(todayYmdInZone(now, FALLBACK_TZ))
  if (!today) return { ok: false }
  const offsetDays = Math.round((wantMs - Date.UTC(today.year, today.month - 1, today.day)) / DAY_MS)
  if (offsetDays < -DATE_WINDOW_PAST_DAYS || offsetDays > DATE_WINDOW_FUTURE_DAYS) return { ok: false }
  return { ok: true, ymd: dateStr }
}

// ── Hours (pure) ────────────────────────────────────────────────────────────

function dayWindow(school, prefix) {
  if (school[`${prefix}_is_24_hours`]) return { enabled: true, open24h: true, start: null, end: null }
  if (!school[`${prefix}_enabled`]) return { enabled: false, open24h: false, start: null, end: null }
  return { enabled: true, open24h: false, start: school[`${prefix}_start`] || null, end: school[`${prefix}_end`] || null }
}

function windowLabel(win) {
  if (!win.enabled) return 'Closed'
  if (win.open24h) return 'Open 24 hours'
  const a = formatClock12(win.start)
  const b = formatClock12(win.end)
  return a && b ? `${a} - ${b}` : 'Hours unavailable'
}

/**
 * The week's hours by weekday name. `menuWeekdays` names the weekdays the
 * fetched week publishes a menu on: a day flagged closed that has one reads
 * HOURS_NOT_LISTED rather than Closed (issue #465).
 */
export function extractWeeklyHours(school, { menuWeekdays = [] } = {}) {
  const result = {}
  DAY_PREFIXES.forEach((p, i) => {
    const win = dayWindow(school, p)
    result[DAY_LABELS[i]] = !win.enabled && menuWeekdays.includes(DAY_LABELS[i]) ? HOURS_NOT_LISTED : windowLabel(win)
  })
  return result
}

/**
 * Open right now? Handles 24-hour days, windows that end after midnight
 * (11:00 AM - 2:00 AM is open at 1:00 AM), and yesterday's window spilling
 * into the early hours of today. `closes_at` / `opens_at` are 12-hour clocks
 * for the display line ("Open now, until 9:00 PM" / "Closed, opens 7:00 AM").
 * A day flagged closed whose weekday is in `menuWeekdays` (it has a published
 * menu) is `is_open: null`, "not known", with HOURS_NOT_LISTED (issue #465).
 */
export function deriveStatusFromSchool(school, now = new Date(), { menuWeekdays = [] } = {}) {
  const tz = school.timezone || FALLBACK_TZ
  const todayIdx = dayIndexInZone(now, tz)
  const nowM = wallClockMinutesInTimeZone(now, tz)
  const today = dayWindow(school, DAY_PREFIXES[todayIdx])
  const yesterday = dayWindow(school, DAY_PREFIXES[(todayIdx + 6) % 7])
  const hours = windowLabel(today)

  if (yesterday.enabled && !yesterday.open24h) {
    const s = parseTimeToMinutes(yesterday.start)
    const e = parseTimeToMinutes(yesterday.end)
    if (s != null && e != null && e < s && nowM <= e) {
      return { is_open: true, hours, closes_at: formatClock12(yesterday.end), opens_at: null, open24h: false, tz }
    }
  }
  if (!today.enabled) {
    if (menuWeekdays.includes(DAY_LABELS[todayIdx])) {
      return { is_open: null, hours: HOURS_NOT_LISTED, closes_at: null, opens_at: null, open24h: false, tz }
    }
    return { is_open: false, hours: 'Closed today', closes_at: null, opens_at: null, open24h: false, tz }
  }
  if (today.open24h) return { is_open: true, hours, closes_at: null, opens_at: null, open24h: true, tz }

  const startM = parseTimeToMinutes(today.start)
  const endM = parseTimeToMinutes(today.end)
  if (startM == null || endM == null) return { is_open: false, hours, closes_at: null, opens_at: null, open24h: false, tz }

  const wraps = endM < startM
  const open = wraps ? nowM >= startM || nowM <= endM : nowM >= startM && nowM <= endM
  return {
    is_open: open,
    hours,
    closes_at: open ? formatClock12(today.end) : null,
    opens_at: !open && nowM < startM ? formatClock12(today.start) : null,
    open24h: false,
    tz,
  }
}

// ── Menus (pure) ────────────────────────────────────────────────────────────

function extractIconLabels(food) {
  const icons = food?.icons?.food_icons
  if (!Array.isArray(icons)) return []
  const out = []
  for (const ic of icons) {
    if (ic && ic.enabled !== false) {
      const label = ic.synced_name || ic.name || ic.slug
      if (label) out.push(String(label))
    }
  }
  return [...new Set(out)]
}

function normalizeFoodEntry(food) {
  if (!food?.name) return null
  const cal = food.rounded_nutrition_info?.calories
  return { name: food.name, calories: typeof cal === 'number' ? cal : null, icons: extractIconLabels(food) }
}

// Station/section names to omit entirely - condiments, toppings, garnishes, etc.
const SKIP_SECTION_RE = /condiment|^toppings?$|^garnish|infused.{0,8}water|sugar.{0,12}sub(stitute)?|sweetener|creamer|^spreads?$|^sauces?$|^dressings?$|\bbeverage/i

export function shouldSkipSection(name) {
  return SKIP_SECTION_RE.test((name || '').trim())
}

/**
 * True when one day's flat menu_items list at least one food outside the
 * skipped sections, the same foods ingestMenuStations would show. Used to
 * tell which days of a fetched week carry a published menu (issue #465).
 */
export function hasPublishedFood(menuItems) {
  if (!Array.isArray(menuItems)) return false
  let skip = false
  for (const row of menuItems) {
    if (row?.is_section_title || row?.is_station_header) {
      skip = shouldSkipSection(row.text)
      continue
    }
    if (!skip && row?.food?.name) return true
  }
  return false
}

/** The weekday names, Sunday first, that any of `dates` (YYYY-MM-DD) fall on. */
function weekdaysOf(dates) {
  const names = new Set([...dates].map(weekdayForYmd).filter(Boolean))
  return DAY_LABELS.filter((d) => names.has(d))
}

// A station serves "every day" (issue #466) when its foods on a day match the
// same station's foods on the other days of that week, same meal: a median
// overlap (Jaccard) of at least EVERYDAY_MIN_OVERLAP over at least
// EVERYDAY_MIN_OTHER_DAYS other days that have the station. Over the fall 2026
// semester this marks Salad Bar, Daily Grill, Pizza, Hasta La Pasta, Rice It Up
// and Grill Breakfast Options every day on all 83 days, and Homestyle,
// Breakfast Entree Line, Chef Made Soups, Dessert and Innovation on none.
export const EVERYDAY_MIN_OVERLAP = 0.6
export const EVERYDAY_MIN_OTHER_DAYS = 2

/** Station name -> Set of food keys for one day's flat menu_items, skipped sections dropped. */
export function stationFoods(menuItems) {
  const foods = new Map()
  if (!Array.isArray(menuItems)) return foods
  let station = 'Menu'
  let skip = false
  for (const row of menuItems) {
    if (row?.is_section_title || row?.is_station_header) {
      station = (row.text || '').trim() || 'Menu'
      skip = shouldSkipSection(station)
      continue
    }
    if (skip || !row?.food?.name) continue
    if (!foods.has(station)) foods.set(station, new Set())
    foods.get(station).add(row.food.id != null ? `id:${row.food.id}` : `name:${row.food.name}`)
  }
  return foods
}

function jaccard(a, b) {
  let shared = 0
  for (const key of a) if (b.has(key)) shared += 1
  const union = a.size + b.size - shared
  return union ? shared / union : 1
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The names of the stations on `ymd` that serve the same food on most other
 * days of `days`, one meal's week as Nutrislice sends it (Sunday to Saturday).
 * Learnt from the week, never from station names, so a station that starts or
 * stops rotating moves on its own.
 */
export function everydayStations(days, ymd) {
  const byDate = new Map((days || []).filter((d) => d?.date).map((d) => [d.date, stationFoods(d.menu_items)]))
  const everyday = new Set()
  const today = byDate.get(ymd)
  if (!today) return everyday
  for (const [station, foods] of today) {
    const overlaps = []
    for (const [date, stations] of byDate) {
      if (date !== ymd && stations.has(station)) overlaps.push(jaccard(foods, stations.get(station)))
    }
    if (overlaps.length >= EVERYDAY_MIN_OTHER_DAYS && median(overlaps) >= EVERYDAY_MIN_OVERLAP) everyday.add(station)
  }
  return everyday
}

/**
 * One meal's flat menu_items -> [{ name: station, items: [{ name, calories, icons, meals }] }].
 * Sections matching SKIP_SECTION_RE are dropped. `seen` (dedupe key -> item)
 * dedupes a food that appears under several stations or meals: it stays with
 * the first, and a repeat under another meal adds that meal to its `meals`,
 * so the assistant can tell what is served at lunch (issue #253).
 */
export function ingestMenuStations(menuItems, mealSlug, seen = new Map()) {
  if (!Array.isArray(menuItems)) return []
  const stationMap = new Map()
  let station = 'Menu'
  let skip = false

  for (const row of menuItems) {
    if (row?.is_section_title || row?.is_station_header) {
      station = (row.text || '').trim() || 'Menu'
      skip = shouldSkipSection(station)
      continue
    }
    if (!row?.food || skip) continue
    const norm = normalizeFoodEntry(row.food)
    if (!norm) continue
    const id = row.food.id
    const key = id != null ? `id:${id}` : `name:${norm.name}:${mealSlug}`
    const kept = seen.get(key)
    if (kept) {
      if (!kept.meals.includes(mealSlug)) kept.meals.push(mealSlug)
      continue
    }
    const item = { ...norm, meals: [mealSlug] }
    seen.set(key, item)
    if (!stationMap.has(station)) stationMap.set(station, [])
    stationMap.get(station).push(item)
  }

  return [...stationMap.entries()].map(([name, items]) => ({ name, items })).filter((s) => s.items.length > 0)
}

/** Meal slugs to fetch. An explicit empty list means "publishes no menus". */
export function mealSlugsForSchool(school) {
  const types = school?.active_menu_types
  if (Array.isArray(types)) return [...new Set(types.map((mt) => mt?.slug).filter(Boolean))]
  return [...FALLBACK_MEAL_SLUGS]
}

export function locationKind(school) {
  return mealSlugsForSchool(school).length ? 'dining-hall' : 'retail'
}

export function pickSchools(allSchools) {
  const resolved = []
  for (const spec of LOCATION_FILTERS) {
    const found = (allSchools || []).find(spec.test)
    if (found) resolved.push({ spec, school: found })
  }
  return resolved
}

// ── Fetch shell ─────────────────────────────────────────────────────────────

async function fetchNutrisliceJson(path, fetchImpl = globalThis.fetch) {
  const url = `${apiBase()}${path.startsWith('/') ? path : `/${path}`}${path.includes('?') ? '&' : '?'}format=json`
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' },
    })
    if (!res.ok) return { ok: false, status: res.status, data: null }
    const data = await res.json()
    return { ok: true, status: res.status, data }
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    return { ok: false, status: aborted ? 408 : 0, data: null, error: aborted ? 'timeout' : String(e?.message || e) }
  } finally {
    clearTimeout(t)
  }
}

// One menu row cut to what the menu code reads: a station header, or a food
// with its id, name, calories and diet icons. A week of these is what the
// week cache holds, a small fraction of the raw payload (issue #467).
function slimRow(row) {
  if (row?.is_section_title || row?.is_station_header) {
    return { is_section_title: Boolean(row.is_section_title), is_station_header: Boolean(row.is_station_header), text: row.text || '' }
  }
  const food = row?.food
  if (!food?.name) return null
  const icons = Array.isArray(food.icons?.food_icons)
    ? food.icons.food_icons.map((ic) => ({ enabled: ic?.enabled, synced_name: ic?.synced_name, name: ic?.name, slug: ic?.slug }))
    : []
  return { food: { id: food.id ?? null, name: food.name, rounded_nutrition_info: { calories: food.rounded_nutrition_info?.calories ?? null }, icons: { food_icons: icons } } }
}

/** A week payload -> { lastUpdated, days: Map(YYYY-MM-DD -> slim rows) }. */
export function processWeek(data) {
  const days = new Map()
  for (const d of data?.days || []) {
    if (d?.date) days.set(d.date, (d.menu_items || []).map(slimRow).filter(Boolean))
  }
  return { lastUpdated: typeof data?.last_updated === 'string' ? data.last_updated : null, days }
}

// Writing a week moves it to the back of the Map; past MAX_CACHE_WEEKS the
// front (the week written longest ago) is dropped.
function storeWeek(key, entry) {
  weeks.delete(key)
  weeks.set(key, entry)
  while (weeks.size > MAX_CACHE_WEEKS) weeks.delete(weeks.keys().next().value)
}

/**
 * One meal's week for a school, as { ok, status, week }. With `cache` the
 * processed week is kept per (slug, meal, week) for the cache TTL, so the
 * seven dates of a week cost one download per meal, and concurrent misses
 * share one fetch; `refresh` refetches it. A failure is never kept. Without
 * `cache` (buildDiningBase called directly, as the tests do) every call fetches.
 */
async function loadWeek(slug, meal, ymd, { fetchImpl, cache = false, refresh = false, nowMs = Date.now() } = {}) {
  const { year, month, day } = ymdParts(ymd)
  const path = `/menu/api/weeks/school/${encodeURIComponent(slug)}/menu-type/${encodeURIComponent(meal)}/${year}/${month}/${day}/`
  const fetchWeek = async () => {
    const res = await fetchNutrisliceJson(path, fetchImpl)
    return res.ok ? { ok: true, status: res.status, week: processWeek(res.data) } : { ok: false, status: res.status, week: null }
  }
  if (!cache) return fetchWeek()

  const key = `${slug}|${meal}|${weekStartYmd(ymd)}`
  const hit = weeks.get(key)
  // A cached week that somehow lacks the date (a week that is not Sunday to
  // Saturday) is refetched rather than trusted.
  if (!refresh && hit && nowMs < hit.expiresAt && hit.week.days.has(ymd)) return { ok: true, status: 200, week: hit.week }
  let pending = weekFetches.get(key)
  if (!pending) {
    pending = fetchWeek()
      .then((res) => {
        if (res.ok) storeWeek(key, { week: res.week, expiresAt: nowMs + cacheMs() })
        return res
      })
      .finally(() => weekFetches.delete(key))
    weekFetches.set(key, pending)
  }
  return pending
}

/**
 * Today's menus for one hall: `menus`, one entry per meal in serving order,
 * each a complete menu whose stations say whether they serve the same food
 * every day (issue #466); the deprecated flat `stations`, all meals merged and
 * deduped, kept for older clients; `menuWeekdays`, the weekdays of the
 * fetched week (each meal's payload covers Sunday to Saturday) on which any
 * meal publishes food, which the status and the weekly hours read, so a day
 * the feed flags closed but serves a menu is not shown as Closed (issue
 * #465); and, for the freshness check (issue #467), `weeksLoaded` and
 * `lastUpdated`, the newest `last_updated` across the meals.
 */
async function fetchMenusForSchool(school, ymd, { fetchImpl, cache, refresh, nowMs } = {}) {
  if (!ymdParts(ymd)) return { ...emptyMenu(), warnings: ['invalid_date'] }

  const slug = school.slug
  const seen = new Map()
  const stationMerge = new Map()
  const menus = []
  const warnings = []
  const menuDates = new Set()
  let weeksLoaded = 0
  let lastUpdated = null

  for (const meal of mealSlugsForSchool(school)) {
    const res = await loadWeek(slug, meal, ymd, { fetchImpl, cache, refresh, nowMs })
    if (!res.ok) {
      if (res.status !== 404) warnings.push(`menu_${meal}_${res.status || 'err'}`)
      continue
    }
    weeksLoaded += 1
    const { days } = res.week
    if (res.week.lastUpdated && (!lastUpdated || Date.parse(res.week.lastUpdated) > Date.parse(lastUpdated))) lastUpdated = res.week.lastUpdated
    for (const [date, rows] of days) {
      if (hasPublishedFood(rows)) menuDates.add(date)
    }
    // The requested day or nothing: a date missing from its week has no menu
    // (it used to fall back to the week's first day, another day's menu).
    const target = days.get(ymd)
    if (!target?.length) continue

    // This meal on its own: deduped within the meal only, so each tab is a
    // whole menu, and every station flagged from the week it came with.
    const everyday = everydayStations([...days].map(([date, rows]) => ({ date, menu_items: rows })), ymd)
    const mealStations = ingestMenuStations(target, meal).map(({ name, items }) => ({
      name,
      everyday: everyday.has(name),
      items: items.map(({ name, calories, icons }) => ({ name, calories, icons })),
    }))
    if (mealStations.length) menus.push({ meal, stations: mealStations })

    for (const { name, items } of ingestMenuStations(target, meal, seen)) {
      if (!stationMerge.has(name)) stationMerge.set(name, [])
      stationMerge.get(name).push(...items)
    }
  }

  const stations = [...stationMerge.entries()]
    .map(([name, items]) => ({ name, items: items.map(({ name, calories, icons, meals }) => ({ name, calories, icons, meals })) }))
    .filter((s) => s.items.length > 0)
  const order = sortMeals(menus.map((m) => m.meal))
  menus.sort((a, b) => order.indexOf(a.meal) - order.indexOf(b.meal))

  return { menus, stations, meals: order, warnings, menuWeekdays: weekdaysOf(menuDates), weeksLoaded, lastUpdated }
}

function emptyMenu() {
  return { menus: [], stations: [], meals: [], warnings: [], menuWeekdays: [], weeksLoaded: 0, lastUpdated: null }
}

/**
 * Whether a hall's menu feed looks abandoned (issue #467), for `now`:
 * `empty_week` when the fetched weeks have no food on any day of any meal,
 * `not_updated` when the newest `last_updated` is more than STALE_FEED_DAYS
 * old. When no week loaded at all, that is an outage, which the snapshot's
 * warnings and stale flag already report, not a stale feed.
 */
export function menuFreshness(menu, now = new Date()) {
  const lastUpdated = menu?.lastUpdated ?? null
  if (!menu?.weeksLoaded) return { last_updated: lastUpdated, stale: false, reason: null }
  if (!menu.menuWeekdays?.length) return { last_updated: lastUpdated, stale: true, reason: 'empty_week' }
  const updatedMs = Date.parse(lastUpdated)
  if (Number.isFinite(updatedMs) && now.getTime() - updatedMs > STALE_FEED_DAYS * DAY_MS) {
    return { last_updated: lastUpdated, stale: true, reason: 'not_updated' }
  }
  return { last_updated: lastUpdated, stale: false, reason: null }
}

/**
 * The expensive half: pick the known halls out of the district's school list
 * and fetch today's menus for the ones that publish any. The result carries
 * the raw school rows so the open/closed status can be recomputed on every
 * read (renderSnapshot), not frozen for the life of the cache. `cache` turns
 * on the week cache (getDiningSnapshot does; a direct call fetches every
 * week), and `refresh` refetches the weeks it holds.
 */
export async function buildDiningBase(allSchools, ymd, { fetchImpl, cache = false, refresh = false, now = new Date() } = {}) {
  const picked = pickSchools(allSchools)
  const entries = []
  for (const { spec, school } of picked) {
    const kind = locationKind(school)
    let menu = emptyMenu()
    if (kind === 'dining-hall') {
      try {
        menu = await fetchMenusForSchool(school, ymd, { fetchImpl, cache, refresh, nowMs: now.getTime() })
      } catch (e) {
        menu = { ...emptyMenu(), warnings: [`menu_exception:${String(e?.message || e)}`] }
      }
    }
    entries.push({ spec, school, kind, menu })
  }
  return {
    date: ymd,
    apiBase: apiBase(),
    entries,
    missing: LOCATION_FILTERS.filter((f) => !picked.some((p) => p.spec === f)).map((f) => f.label),
  }
}

/** The public snapshot for `now`: base data plus live open/closed per location. */
export function renderSnapshot(base, now = new Date()) {
  const locations = base.entries.map(({ spec, school, kind, menu }) => {
    const menuWeekdays = menu.menuWeekdays || []
    const status = deriveStatusFromSchool(school, now, { menuWeekdays })
    const menusPublished = kind === 'dining-hall' && menu.meals.length > 0
    const meal = kind === 'retail' ? RETAIL_MENU_NOTE : menusPublished ? `Menus: ${menu.meals.join(', ')}` : NO_MENU_NOTE
    return {
      id: school.slug,
      slug: school.slug,
      name: school.name || spec.label,
      kind,
      address: spec.address || null,
      is_open: status.is_open,
      hours: status.hours,
      closes_at: status.closes_at,
      opens_at: status.opens_at,
      open24h: status.open24h,
      weekly_hours: extractWeeklyHours(school, { menuWeekdays }),
      timezone: status.tz,
      meal,
      menusPublished,
      // One whole menu per meal, stations flagged `everyday` (issue #466).
      menus: menu.menus || [],
      // Deprecated: every meal merged into one list. Kept until the clients
      // that read only this are gone; the page, Home and the assistant read `menus`.
      stations: menu.stations,
      // Is the menu feed being kept up (issue #467)? Null for a retail hall.
      menu_source: kind === 'dining-hall' ? menuFreshness(menu, now) : null,
      warnings: menu.warnings.length ? menu.warnings : undefined,
    }
  })
  return {
    ok: true,
    date: base.date,
    weekday: weekdayForYmd(base.date),
    timezone: FALLBACK_TZ,
    apiBase: base.apiBase,
    locations,
    missing: base.missing,
  }
}

function errorSnapshot(status, ymd, now, ttl) {
  return {
    ok: false,
    error: 'schools_fetch_failed',
    status,
    locations: [],
    date: ymd,
    weekday: weekdayForYmd(ymd),
    timezone: FALLBACK_TZ,
    fetchedAt: now.toISOString(),
    cacheTtlMs: ttl,
    cached: false,
    cacheExpiresAt: new Date(now.getTime() + ttl).toISOString(),
  }
}

// Writing a date moves it to the back of the Map; past MAX_CACHE_DATES the
// front (the date written longest ago) is dropped.
function storeEntry(ymd, entry) {
  entries.delete(ymd)
  entries.set(ymd, entry)
  while (entries.size > MAX_CACHE_DATES) entries.delete(entries.keys().next().value)
  return entry
}

/** The payload for a cache entry, with open/closed computed for `now`. */
function snapshotFromEntry(entry, now, ttl, cached) {
  if (!entry.base) return { ...entry.error, cached }
  return {
    ...renderSnapshot(entry.base, now),
    fetchedAt: entry.fetchedAt,
    cacheTtlMs: ttl,
    cached,
    stale: entry.stale === true,
    cacheExpiresAt: new Date(entry.expiresAt).toISOString(),
  }
}

/**
 * One upstream crawl for a date: schools, then menus, the menu weeks through
 * the week cache, which `refresh` (a forced refresh past its floor) bypasses.
 * `checkedAt` records the attempt for the refresh floor. Resolves to the
 * stored entry, with `cached` true when an outage left the date's last good
 * data serving instead.
 */
async function refreshDiningEntry(ymd, now, ttl, fetchImpl, refresh = false) {
  const nowMs = now.getTime()
  const schoolsRes = await fetchNutrisliceJson('/menu/api/schools/', fetchImpl)
  if (!schoolsRes.ok || !Array.isArray(schoolsRes.data)) {
    const prev = entries.get(ymd)
    if (prev?.base) {
      // Outage: keep serving the last good data, try upstream again shortly.
      const entry = storeEntry(ymd, { ...prev, checkedAt: nowMs, expiresAt: nowMs + FAILURE_RETRY_MS, stale: true })
      return { entry, cached: true }
    }
    const error = errorSnapshot(schoolsRes.status, ymd, now, FAILURE_RETRY_MS)
    const entry = storeEntry(ymd, { base: null, error, checkedAt: nowMs, expiresAt: nowMs + FAILURE_RETRY_MS })
    return { entry, cached: false }
  }

  const base = await buildDiningBase(schoolsRes.data, ymd, { fetchImpl, cache: true, refresh, now })
  const entry = storeEntry(ymd, {
    base,
    fetchedAt: now.toISOString(),
    checkedAt: nowMs,
    expiresAt: nowMs + ttl,
    stale: false,
    error: null,
  })
  return { entry, cached: false }
}

/**
 * Cached dining snapshot, one cache entry per Indianapolis date (issue #208).
 * Schools and menus are fetched at most every NUTRISLICE_CACHE_MS (12 h) per
 * date, today's key moves on when the date rolls over, and concurrent misses
 * for a date share one crawl. The open/closed status is recomputed for every
 * call. `forceRefresh` is a hint: it skips the TTL only once the date's last
 * upstream attempt is MIN_REFRESH_INTERVAL_MS old, and the payload then says
 * whether it did (`refreshed`). While Nutrislice is down the last good data
 * keeps serving (`stale: true`) and upstream is retried every
 * FAILURE_RETRY_MS. Under the dates, the menu weeks are cached per school,
 * meal and week (issue #467), so a new date in a week already fetched costs
 * only the schools list; a forced refresh refetches its weeks.
 */
export async function getDiningSnapshot(options = {}) {
  const { forceRefresh = false, date: dateOverride, now = new Date(), fetchImpl } = options
  const nowMs = now.getTime()
  const ttl = cacheMs()
  const wantYmd = dateOverride || todayYmdInZone(now, FALLBACK_TZ)
  const entry = entries.get(wantYmd)

  const refreshDue = forceRefresh && (!entry || nowMs - entry.checkedAt >= MIN_REFRESH_INTERVAL_MS)
  let snapshot
  if (entry && nowMs < entry.expiresAt && !refreshDue) {
    snapshot = snapshotFromEntry(entry, now, ttl, true)
  } else {
    let pending = inFlight.get(wantYmd)
    if (!pending) {
      pending = refreshDiningEntry(wantYmd, now, ttl, fetchImpl, refreshDue).finally(() => {
        inFlight.delete(wantYmd)
      })
      inFlight.set(wantYmd, pending)
    }
    const result = await pending
    snapshot = snapshotFromEntry(result.entry, now, ttl, result.cached)
  }
  return forceRefresh ? { ...snapshot, refreshed: !snapshot.cached } : snapshot
}

export function __resetDiningCacheForTests() {
  entries.clear()
  inFlight.clear()
  weeks.clear()
  weekFetches.clear()
}

/** How many dates and weeks the caches hold, for the bound tests. */
export function __diningCacheSizesForTests() {
  return { dates: entries.size, weeks: weeks.size }
}
