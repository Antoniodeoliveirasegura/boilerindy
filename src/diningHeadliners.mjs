// Headliners and what is coming up on the menus (issue #469).
//
// Nutrislice's digest answers, for one school, meal and week, each weekday's
// few headline dishes with their photos, in about 2.3 KB:
//   GET /menu/api/weeks/digest/school/<slug>/menu-type/<meal>/date/<y>/<m>/<d>/?format=json
//   -> [{ date, menu_items: [names], images: [url or null], holiday_text }]
// Weekends are not in it. A full week (issue #467) is 0.4 to 2.5 MB, so the
// look-ahead reads the digest for the weeks to come and the cached full week
// only for the rest of the current one, where it also has the weekends and the
// soups and desserts the digest leaves out.
//
// Shape: a pure parser, a digest cache per (school, meal, week) that keeps the
// last good digest through an outage, and getDiningUpcoming, which merges the
// two sources into one list of days.

import { sortMeals } from './diningMeals.mjs'
import { FAILURE_RETRY_MS, fetchNutrisliceJson, getDiningSnapshot, todayYmdInZone, weekSpecials, weekStartYmd } from './nutrisliceDining.mjs'

// The meals the digest is read for: the ones whose headliners rotate.
export const DIGEST_MEALS = ['lunch', 'dinner']
// This week and the six after it: Nutrislice posts menus about six weeks
// ahead (on 2026-10-17 they ran through 2026-11-27). Fourteen requests of
// about 2.3 KB per cache period.
export const DIGEST_WEEKS = 7
// A day further out than this is a draft that can still change.
export const TENTATIVE_AFTER_DAYS = 7
export const MAX_CACHE_DIGESTS = 32
const DEFAULT_DIGEST_CACHE_MS = 12 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const digests = new Map()

function digestCacheMs() {
  const n = Number(process.env.NUTRISLICE_CACHE_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DIGEST_CACHE_MS
}

function ymdParts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '')
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null
}

function plusDays(ymd, n) {
  const p = ymdParts(ymd)
  return new Date(Date.UTC(p.year, p.month - 1, p.day + n)).toISOString().slice(0, 10)
}

function daysBetween(from, to) {
  const a = ymdParts(from)
  const b = ymdParts(to)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS)
}

/** A digest payload -> [{ date, meal, dishes: [{ name, image }], holiday }]; anything else -> []. */
export function parseDigest(data, meal) {
  if (!Array.isArray(data)) return []
  return data
    .filter((d) => typeof d?.date === 'string')
    .map((d) => {
      const names = Array.isArray(d.menu_items) ? d.menu_items : []
      const images = Array.isArray(d.images) ? d.images : []
      const dishes = names
        .map((name, i) => ({ name: typeof name === 'string' ? name.trim() : '', image: typeof images[i] === 'string' && images[i] ? images[i] : null }))
        .filter((dish) => dish.name)
      const holiday = typeof d.holiday_text === 'string' && d.holiday_text.trim() ? d.holiday_text.trim() : null
      return { date: d.date, meal, dishes, holiday }
    })
}

// Writing a digest moves it to the back of the Map; past MAX_CACHE_DIGESTS the
// front is dropped.
function storeDigest(key, entry) {
  digests.delete(key)
  digests.set(key, entry)
  while (digests.size > MAX_CACHE_DIGESTS) digests.delete(digests.keys().next().value)
}

/**
 * One week's digest for a school and meal, cached for NUTRISLICE_CACHE_MS. A
 * failed refresh keeps serving the last good digest and tries again after
 * FAILURE_RETRY_MS; with nothing cached it answers null.
 */
async function loadDigest(slug, meal, sundayYmd, { fetchImpl, nowMs }) {
  const key = `${slug}|${meal}|${sundayYmd}`
  const hit = digests.get(key)
  if (hit && nowMs < hit.expiresAt) return hit.days
  const { year, month, day } = ymdParts(sundayYmd)
  const res = await fetchNutrisliceJson(
    `/menu/api/weeks/digest/school/${encodeURIComponent(slug)}/menu-type/${encodeURIComponent(meal)}/date/${year}/${month}/${day}/`,
    fetchImpl,
  )
  if (!res.ok || !Array.isArray(res.data)) {
    if (hit) {
      storeDigest(key, { ...hit, expiresAt: nowMs + FAILURE_RETRY_MS })
      return hit.days
    }
    return null
  }
  const days = parseDigest(res.data, meal)
  storeDigest(key, { days, expiresAt: nowMs + digestCacheMs() })
  return days
}

/**
 * What is coming up, from today to the end of the posted horizon:
 * { ok, today, days: [{ date, tentative, holiday, meals: [{ meal, location,
 * headliners: [{ name, image }], specials: [name] }] }] }. `headliners` come
 * from the digest (weekdays, lunch and dinner, about six weeks out);
 * `specials` from the cached full week, for the rest of this week only, every
 * meal and the weekend included. A day more than TENTATIVE_AFTER_DAYS out is
 * `tentative`. The digest is read for every dining hall in today's snapshot.
 */
export async function getDiningUpcoming({ now = new Date(), fetchImpl, weeks = DIGEST_WEEKS } = {}) {
  const today = todayYmdInZone(now)
  const snapshot = await getDiningSnapshot({ now, fetchImpl })
  if (!snapshot?.ok) return { ok: false, error: 'dining_upcoming_unavailable', today, days: [] }

  const byDate = new Map()
  const slot = (date, meal, location) => {
    if (!byDate.has(date)) byDate.set(date, { date, holiday: null, meals: new Map() })
    const day = byDate.get(date)
    const key = `${location}|${meal}`
    if (!day.meals.has(key)) day.meals.set(key, { meal, location, headliners: [], specials: [] })
    return day.meals.get(key)
  }

  for (const { date, location, meal, dishes } of await weekSpecials(today, { now, fetchImpl })) {
    slot(date, meal, location).specials.push(...dishes.map((d) => d.name))
  }

  const sunday = weekStartYmd(today)
  const nowMs = now.getTime()
  for (const hall of snapshot.locations.filter((l) => l.kind === 'dining-hall')) {
    for (const meal of DIGEST_MEALS) {
      for (let w = 0; w < weeks; w += 1) {
        const days = await loadDigest(hall.slug, meal, plusDays(sunday, 7 * w), { fetchImpl, nowMs })
        for (const d of days || []) {
          if (d.date < today) continue
          if (d.holiday) {
            if (!byDate.has(d.date)) byDate.set(d.date, { date: d.date, holiday: null, meals: new Map() })
            byDate.get(d.date).holiday = d.holiday
          }
          if (d.dishes.length) slot(d.date, meal, hall.name).headliners.push(...d.dishes)
        }
      }
    }
  }

  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((day) => {
      const meals = [...day.meals.values()]
      const order = sortMeals([...new Set(meals.map((m) => m.meal))])
      meals.sort((a, b) => order.indexOf(a.meal) - order.indexOf(b.meal) || a.location.localeCompare(b.location))
      return { date: day.date, tentative: daysBetween(today, day.date) > TENTATIVE_AFTER_DAYS, holiday: day.holiday, meals }
    })
  return { ok: true, today, days }
}

export function __resetDiningHeadlinersForTests() {
  digests.clear()
}
