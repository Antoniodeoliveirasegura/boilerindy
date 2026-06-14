/**
 * IU Indianapolis / IUPUI dining via Nutrislice JSON API.
 * HTML lives on {district}.nutrislice.com; JSON is on {district}.api.nutrislice.com with ?format=json.
 */

const DEFAULT_API_BASE = 'https://iupui.api.nutrislice.com'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 18_000
const DEFAULT_CACHE_MS = 12 * 60 * 60 * 1000

const FALLBACK_TZ = 'America/Indiana/Indianapolis'

const LOCATION_FILTERS = [
  { id: 'tower-dining', label: 'Tower Dining', test: (s) => /\btower\b/i.test(s.name || '') && /\bdining\b/i.test(s.name || '') },
  { id: 'campus-center', label: 'Campus Center', test: (s) => /\bcampus\s*center\b/i.test(s.name || '') },
]

const FALLBACK_MEAL_SLUGS = ['breakfast', 'lunch', 'dinner', 'everyday']

const WEEKDAY_TO_PREFIX = {
  sunday: 'sun',
  monday: 'mon',
  tuesday: 'tue',
  wednesday: 'wed',
  thursday: 'thu',
  friday: 'fri',
  saturday: 'sat',
}

let cache = { payload: null, expiresAt: 0 }

function apiBase() {
  return (process.env.NUTRISLICE_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '')
}

function cacheMs() {
  const n = Number(process.env.NUTRISLICE_CACHE_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_MS
}

function dayPrefixInZone(date, timeZone) {
  const long = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date).toLowerCase()
  return WEEKDAY_TO_PREFIX[long] || 'mon'
}

function wallClockMinutesInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

function parseTimeToMinutes(clock) {
  if (!clock || typeof clock !== 'string') return null
  const [h, m] = clock.split(':').map((x) => Number(x))
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

function formatClock12(clock) {
  const mins = parseTimeToMinutes(clock)
  if (mins == null) return ''
  let h = Math.floor(mins / 60)
  const m = mins % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`
}

function todayYmdInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
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

async function fetchNutrisliceJson(path) {
  const url = `${apiBase()}${path.startsWith('/') ? path : `/${path}`}${path.includes('?') ? '&' : '?'}format=json`
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
      },
    })
    if (res.status === 404) return { ok: false, status: 404, data: null }
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
  return {
    name: food.name,
    calories: typeof cal === 'number' ? cal : null,
    icons: extractIconLabels(food),
  }
}

// Station/section names to completely omit — condiments, toppings, garnishes, etc.
const SKIP_SECTION_RE = /condiment|^toppings?$|^garnish|infused.{0,8}water|sugar.{0,12}sub(stitute)?|sweetener|creamer|^spreads?$|^sauces?$|^dressings?$|\bbeverage/i

function shouldSkipSection(name) {
  return SKIP_SECTION_RE.test((name || '').trim())
}

// Build per-station item lists from one meal's flat menu_items array.
// Returns [{name: stationName, items: [{name, calories, icons, meal}]}]
// Sections matching SKIP_SECTION_RE are dropped entirely.
function ingestMenuStations(menuItems, mealSlug, seenKeys) {
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

  return [...stationMap.entries()]
    .map(([name, items]) => ({ name, items }))
    .filter((s) => s.items.length > 0)
}

const DAY_PREFIXES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function extractWeeklyHours(school) {
  const result = {}
  for (let i = 0; i < DAY_PREFIXES.length; i++) {
    const p = DAY_PREFIXES[i]
    const enabled = school[`${p}_enabled`]
    if (!enabled) {
      result[DAY_LABELS[i]] = 'Closed'
      continue
    }
    const start = school[`${p}_start`]
    const end = school[`${p}_end`]
    const a = formatClock12(start)
    const b = formatClock12(end)
    result[DAY_LABELS[i]] = a && b ? `${a} - ${b}` : 'Hours unavailable'
  }
  return result
}

function deriveStatusFromSchool(school, now = new Date()) {
  const tz = school.timezone || FALLBACK_TZ
  const prefix = dayPrefixInZone(now, tz)
  const enabled = school[`${prefix}_enabled`]
  const start = school[`${prefix}_start`]
  const end = school[`${prefix}_end`]

  if (!enabled) {
    return { is_open: false, hours: 'Closed today', tz }
  }

  const startM = parseTimeToMinutes(start)
  const endM = parseTimeToMinutes(end)
  if (startM == null || endM == null) {
    return { is_open: false, hours: 'Hours unavailable', tz }
  }

  const nowM = wallClockMinutesInTimeZone(now, tz)
  const open = nowM >= startM && nowM <= endM
  const hours = `${formatClock12(start)} - ${formatClock12(end)}`
  return { is_open: open, hours, tz }
}

function mealSlugsForSchool(school) {
  const fromApi = (school.active_menu_types || []).map((mt) => mt.slug).filter(Boolean)
  if (fromApi.length) return [...new Set(fromApi)]
  return [...FALLBACK_MEAL_SLUGS]
}

async function fetchMenusForSchool(school, ymd) {
  const parts = ymdParts(ymd)
  if (!parts) return { stations: [], meals: [], warnings: ['invalid_date'] }

  const { year, month, day } = parts
  const slug = school.slug
  const mealSlugs = mealSlugsForSchool(school)
  const seenKeys = new Set()
  const stationMerge = new Map() // stationName → items[]
  const mealsFound = []
  const warnings = []

  for (const meal of mealSlugs) {
    const path = `/menu/api/weeks/school/${encodeURIComponent(slug)}/menu-type/${encodeURIComponent(meal)}/${year}/${month}/${day}/`
    const res = await fetchNutrisliceJson(path)
    if (!res.ok) {
      if (res.status === 404) continue
      warnings.push(`menu_${meal}_${res.status || 'err'}`)
      continue
    }
    const week = res.data
    const days = week?.days || []
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
    .map(([name, items]) => ({
      name,
      items: items.map(({ name, calories, icons }) => ({ name, calories, icons })),
    }))
    .filter((s) => s.items.length > 0)

  return { stations, meals: mealsFound, warnings }
}

function pickSchools(allSchools) {
  const resolved = []
  for (const spec of LOCATION_FILTERS) {
    const found = (allSchools || []).find(spec.test)
    if (found) resolved.push({ spec, school: found })
  }
  return resolved
}

async function buildSnapshotBody(ymd, allSchools) {
  if (!Array.isArray(allSchools)) {
    return {
      ok: false,
      error: 'schools_fetch_failed',
      status: 0,
      locations: [],
      date: ymd,
    }
  }

  const picked = pickSchools(allSchools)
  const locations = []

  for (const { spec, school } of picked) {
    const status = deriveStatusFromSchool(school)
    let stations = []
    let meals = []
    const warnings = []

    try {
      const result = await fetchMenusForSchool(school, ymd)
      stations = result.stations
      meals = result.meals
      warnings.push(...(result.warnings || []))
    } catch (e) {
      warnings.push(`menu_exception:${String(e?.message || e)}`)
    }

    const mealHint = meals.length > 0 ? `Menus: ${meals.join(', ')}` : 'Menu not posted yet'

    locations.push({
      id: school.slug,
      slug: school.slug,
      name: school.name || spec.label,
      is_open: status.is_open,
      hours: status.hours,
      weekly_hours: extractWeeklyHours(school),
      timezone: status.tz,
      meal: mealHint || '—',
      stations,
      warnings: warnings.length ? warnings : undefined,
    })
  }

  return {
    ok: true,
    date: ymd,
    apiBase: apiBase(),
    locations,
    missing: LOCATION_FILTERS.filter((f) => !picked.some((p) => p.spec === f)).map((f) => f.label),
  }
}

/**
 * Cached dining snapshot (~2 refreshes per day by default via 12h TTL).
 */
export async function getDiningSnapshot(options = {}) {
  const { forceRefresh = false, date: dateOverride } = options
  const now = Date.now()
  if (!forceRefresh && cache.payload && now < cache.expiresAt) {
    return { ...cache.payload, cached: true, cacheExpiresAt: new Date(cache.expiresAt).toISOString() }
  }

  const schoolsRes = await fetchNutrisliceJson('/menu/api/schools/')
  if (!schoolsRes.ok || !Array.isArray(schoolsRes.data)) {
    const errPayload = {
      ok: false,
      error: 'schools_fetch_failed',
      status: schoolsRes.status,
      locations: [],
      date: dateOverride || todayYmdInZone(new Date(), FALLBACK_TZ),
      fetchedAt: new Date().toISOString(),
      cacheTtlMs: cacheMs(),
      cached: false,
      cacheExpiresAt: new Date(now + cacheMs()).toISOString(),
    }
    cache = { payload: errPayload, expiresAt: now + cacheMs() }
    return errPayload
  }

  const allSchools = schoolsRes.data
  const firstTz = allSchools.find((s) => s.timezone)?.timezone
  const ymd = dateOverride || todayYmdInZone(new Date(), firstTz || FALLBACK_TZ)

  const body = await buildSnapshotBody(ymd, allSchools)
  const fetchedAt = new Date().toISOString()
  const ttl = cacheMs()
  const payload = {
    ...body,
    fetchedAt,
    cacheTtlMs: ttl,
    cached: false,
    cacheExpiresAt: new Date(now + ttl).toISOString(),
  }

  cache = { payload, expiresAt: now + ttl }
  return payload
}

export function __resetDiningCacheForTests() {
  cache = { payload: null, expiresAt: 0 }
}
