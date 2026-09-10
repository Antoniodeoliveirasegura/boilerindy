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
 * the open/closed rule), a fetch shell with an injectable fetch, and a cache
 * that holds the expensive part (schools + menus) for hours while the
 * open/closed status is recomputed on every read, so "Open now" is never
 * hours stale.
 */

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

let cache = null

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

function wallClockMinutesInTimeZone(date, timeZone) {
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

/** Long weekday name for a YYYY-MM-DD calendar date, independent of any zone. */
export function weekdayForYmd(ymd) {
  const p = ymdParts(ymd)
  if (!p) return null
  return DAY_LABELS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]
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

export function extractWeeklyHours(school) {
  const result = {}
  DAY_PREFIXES.forEach((p, i) => {
    result[DAY_LABELS[i]] = windowLabel(dayWindow(school, p))
  })
  return result
}

/**
 * Open right now? Handles 24-hour days, windows that end after midnight
 * (11:00 AM - 2:00 AM is open at 1:00 AM), and yesterday's window spilling
 * into the early hours of today. `closes_at` / `opens_at` are 12-hour clocks
 * for the display line ("Open now, until 9:00 PM" / "Closed, opens 7:00 AM").
 */
export function deriveStatusFromSchool(school, now = new Date()) {
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
  if (!today.enabled) return { is_open: false, hours: 'Closed today', closes_at: null, opens_at: null, open24h: false, tz }
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
 * One meal's flat menu_items -> [{ name: station, items: [{ name, calories, icons, meal }] }].
 * Sections matching SKIP_SECTION_RE are dropped; `seenKeys` dedupes a food
 * that appears under several stations or meals.
 */
export function ingestMenuStations(menuItems, mealSlug, seenKeys = new Set()) {
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
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    if (!stationMap.has(station)) stationMap.set(station, [])
    stationMap.get(station).push({ ...norm, meal: mealSlug })
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

async function fetchMenusForSchool(school, ymd, fetchImpl) {
  const parts = ymdParts(ymd)
  if (!parts) return { stations: [], meals: [], warnings: ['invalid_date'] }

  const { year, month, day } = parts
  const slug = school.slug
  const seenKeys = new Set()
  const stationMerge = new Map()
  const mealsFound = []
  const warnings = []

  for (const meal of mealSlugsForSchool(school)) {
    const path = `/menu/api/weeks/school/${encodeURIComponent(slug)}/menu-type/${encodeURIComponent(meal)}/${year}/${month}/${day}/`
    const res = await fetchNutrisliceJson(path, fetchImpl)
    if (!res.ok) {
      if (res.status !== 404) warnings.push(`menu_${meal}_${res.status || 'err'}`)
      continue
    }
    const days = res.data?.days || []
    const target = days.find((d) => d.date === ymd) || days[0]
    if (!target?.menu_items?.length) continue

    const stations = ingestMenuStations(target.menu_items, meal, seenKeys)
    if (stations.length) mealsFound.push(meal)
    for (const { name, items } of stations) {
      if (!stationMerge.has(name)) stationMerge.set(name, [])
      stationMerge.get(name).push(...items)
    }
  }

  const stations = [...stationMerge.entries()]
    .map(([name, items]) => ({ name, items: items.map(({ name, calories, icons }) => ({ name, calories, icons })) }))
    .filter((s) => s.items.length > 0)

  return { stations, meals: mealsFound, warnings }
}

/**
 * The expensive half: pick the known halls out of the district's school list
 * and fetch today's menus for the ones that publish any. The result carries
 * the raw school rows so the open/closed status can be recomputed on every
 * read (renderSnapshot), not frozen for the life of the cache.
 */
export async function buildDiningBase(allSchools, ymd, { fetchImpl } = {}) {
  const picked = pickSchools(allSchools)
  const entries = []
  for (const { spec, school } of picked) {
    const kind = locationKind(school)
    let menu = { stations: [], meals: [], warnings: [] }
    if (kind === 'dining-hall') {
      try {
        menu = await fetchMenusForSchool(school, ymd, fetchImpl)
      } catch (e) {
        menu = { stations: [], meals: [], warnings: [`menu_exception:${String(e?.message || e)}`] }
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
    const status = deriveStatusFromSchool(school, now)
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
      weekly_hours: extractWeeklyHours(school),
      timezone: status.tz,
      meal,
      menusPublished,
      stations: menu.stations,
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

/**
 * Cached dining snapshot. Schools and menus are fetched at most every
 * NUTRISLICE_CACHE_MS (12 h) or when the Indianapolis date rolls over; the
 * open/closed status is recomputed for every call. While Nutrislice is down
 * the last good data keeps serving (`stale: true`) and upstream is retried
 * every FAILURE_RETRY_MS.
 */
export async function getDiningSnapshot(options = {}) {
  const { forceRefresh = false, date: dateOverride, now = new Date(), fetchImpl } = options
  const nowMs = now.getTime()
  const ttl = cacheMs()
  const wantYmd = dateOverride || todayYmdInZone(now, FALLBACK_TZ)

  const fresh = cache && cache.base && nowMs < cache.expiresAt && cache.base.date === wantYmd
  if (!forceRefresh && fresh) {
    return {
      ...renderSnapshot(cache.base, now),
      fetchedAt: cache.fetchedAt,
      cacheTtlMs: ttl,
      cached: true,
      stale: cache.stale === true,
      cacheExpiresAt: new Date(cache.expiresAt).toISOString(),
    }
  }
  if (!forceRefresh && cache && !cache.base && nowMs < cache.expiresAt && cache.error) {
    return { ...cache.error, cached: true }
  }

  const schoolsRes = await fetchNutrisliceJson('/menu/api/schools/', fetchImpl)
  if (!schoolsRes.ok || !Array.isArray(schoolsRes.data)) {
    if (cache?.base && cache.base.date === wantYmd) {
      // Outage: keep serving the last good data, try upstream again shortly.
      cache = { ...cache, expiresAt: nowMs + FAILURE_RETRY_MS, stale: true }
      return {
        ...renderSnapshot(cache.base, now),
        fetchedAt: cache.fetchedAt,
        cacheTtlMs: ttl,
        cached: true,
        stale: true,
        cacheExpiresAt: new Date(cache.expiresAt).toISOString(),
      }
    }
    const error = errorSnapshot(schoolsRes.status, wantYmd, now, FAILURE_RETRY_MS)
    cache = { base: null, error, expiresAt: nowMs + FAILURE_RETRY_MS }
    return error
  }

  const base = await buildDiningBase(schoolsRes.data, wantYmd, { fetchImpl })
  const fetchedAt = now.toISOString()
  cache = { base, fetchedAt, expiresAt: nowMs + ttl, stale: false, error: null }
  return {
    ...renderSnapshot(base, now),
    fetchedAt,
    cacheTtlMs: ttl,
    cached: false,
    stale: false,
    cacheExpiresAt: new Date(cache.expiresAt).toISOString(),
  }
}

export function __resetDiningCacheForTests() {
  cache = null
}
