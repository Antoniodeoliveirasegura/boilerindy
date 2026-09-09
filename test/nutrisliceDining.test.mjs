// Tests for the dining module (issue #119). The core is pure: Nutrislice rows
// from the saved fixtures go in, normalized locations with a live open/closed
// status come out. The fetch shell and the cache run against an injected
// fetch and a fixed clock, so no network and no dependence on the real time.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  FAILURE_RETRY_MS,
  LOCATION_FILTERS,
  NO_MENU_NOTE,
  RETAIL_MENU_NOTE,
  __resetDiningCacheForTests,
  buildDiningBase,
  deriveStatusFromSchool,
  extractWeeklyHours,
  formatClock12,
  getDiningSnapshot,
  ingestMenuStations,
  locationKind,
  mealSlugsForSchool,
  pickSchools,
  renderSnapshot,
  shouldSkipSection,
  todayYmdInZone,
  weekdayForYmd,
  weekdayInZone,
} from '../src/nutrisliceDining.mjs'

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const SCHOOLS = load('nutrislice-schools.json')
const TOWER_LUNCH = load('nutrislice-tower-lunch.json')
const CC_LUNCH = load('nutrislice-campus-center-lunch.json')
const tower = SCHOOLS.find((s) => s.slug === 'tower-dining')
const campusCenter = SCHOOLS.find((s) => s.slug === 'campus-center')
const LUNCH_ROWS = TOWER_LUNCH.days.find((d) => d.date === '2026-09-09').menu_items

// Indianapolis is UTC-4 in September; 2026-09-09 is a Wednesday.
const at = (hhmm, ymd = '2026-09-09') => new Date(`${ymd}T${hhmm}:00-04:00`)

function stubFetch(handler) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const answer = handler(url, calls.length)
    if (typeof answer === 'number') return { ok: false, status: answer, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => answer }
  }
  return { fetchImpl, calls }
}

// The live district as it answered on 2026-09-09: both schools, Tower's lunch
// week, an empty published week for the Campus Center, 404 for anything else.
const liveDistrict = (url) => {
  if (url.includes('/menu/api/schools/')) return SCHOOLS
  if (url.includes('/tower-dining/menu-type/lunch/')) return TOWER_LUNCH
  if (url.includes('/campus-center/')) return CC_LUNCH
  return 404
}

beforeEach(() => {
  __resetDiningCacheForTests()
  delete process.env.NUTRISLICE_CACHE_MS
  delete process.env.NUTRISLICE_API_BASE
})

// ── Clock helpers ───────────────────────────────────────────────────────────

test('weekday and date helpers follow the Indianapolis calendar, not the server zone', () => {
  assert.equal(weekdayForYmd('2026-09-09'), 'Wednesday')
  assert.equal(weekdayForYmd('2026-09-13'), 'Sunday')
  assert.equal(weekdayForYmd('nope'), null)
  const lateEvening = at('23:30')
  assert.equal(weekdayInZone(lateEvening), 'Wednesday')
  assert.equal(weekdayInZone(lateEvening, 'Asia/Seoul'), 'Thursday')
  assert.equal(todayYmdInZone(lateEvening), '2026-09-09')
  assert.equal(todayYmdInZone(lateEvening, 'Asia/Seoul'), '2026-09-10')
})

test('formatClock12 renders Nutrislice HH:MM:SS clocks', () => {
  assert.equal(formatClock12('07:00:00'), '7:00 AM')
  assert.equal(formatClock12('21:00:00'), '9:00 PM')
  assert.equal(formatClock12('00:30:00'), '12:30 AM')
  assert.equal(formatClock12('12:00:00'), '12:00 PM')
  assert.equal(formatClock12('garbage'), '')
  assert.equal(formatClock12(null), '')
})

// ── Hours ───────────────────────────────────────────────────────────────────

test('extractWeeklyHours reads the real Tower row: weekdays 7 to 9, weekends closed', () => {
  assert.deepEqual(extractWeeklyHours(tower), {
    Sunday: 'Closed',
    Monday: '7:00 AM - 9:00 PM',
    Tuesday: '7:00 AM - 9:00 PM',
    Wednesday: '7:00 AM - 9:00 PM',
    Thursday: '7:00 AM - 9:00 PM',
    Friday: '7:00 AM - 9:00 PM',
    Saturday: 'Closed',
  })
})

test('deriveStatusFromSchool: open during the window, closed before and after, closed on weekends', () => {
  const open = deriveStatusFromSchool(tower, at('12:00'))
  assert.equal(open.is_open, true)
  assert.equal(open.hours, '7:00 AM - 9:00 PM')
  assert.equal(open.closes_at, '9:00 PM')
  assert.equal(open.opens_at, null)
  assert.equal(open.tz, 'America/Indiana/Indianapolis')

  const early = deriveStatusFromSchool(tower, at('06:30'))
  assert.equal(early.is_open, false)
  assert.equal(early.opens_at, '7:00 AM')

  const late = deriveStatusFromSchool(tower, at('21:30'))
  assert.equal(late.is_open, false)
  assert.equal(late.opens_at, null)
  assert.equal(late.closes_at, null)

  const saturday = deriveStatusFromSchool(tower, at('12:00', '2026-09-12'))
  assert.equal(saturday.is_open, false)
  assert.equal(saturday.hours, 'Closed today')
})

test('deriveStatusFromSchool handles 24-hour days, windows past midnight, and missing times', () => {
  const allNight = { wed_enabled: true, wed_is_24_hours: true }
  const s = deriveStatusFromSchool(allNight, at('03:00'))
  assert.equal(s.is_open, true)
  assert.equal(s.open24h, true)
  assert.equal(s.hours, 'Open 24 hours')
  assert.equal(extractWeeklyHours(allNight).Wednesday, 'Open 24 hours')

  // Late-night grill: 11:00 AM to 2:00 AM Wednesday and Thursday.
  const lateNight = {
    wed_enabled: true, wed_start: '11:00:00', wed_end: '02:00:00',
    thu_enabled: true, thu_start: '11:00:00', thu_end: '02:00:00',
  }
  assert.equal(deriveStatusFromSchool(lateNight, at('23:30')).is_open, true)
  assert.equal(deriveStatusFromSchool(lateNight, at('23:30')).closes_at, '2:00 AM')
  // 1:00 AM Thursday: still inside Wednesday's window.
  const spill = deriveStatusFromSchool(lateNight, at('01:00', '2026-09-10'))
  assert.equal(spill.is_open, true)
  assert.equal(spill.closes_at, '2:00 AM')
  assert.equal(spill.hours, '11:00 AM - 2:00 AM')
  // 3:00 AM Thursday: closed until 11.
  const gap = deriveStatusFromSchool(lateNight, at('03:00', '2026-09-10'))
  assert.equal(gap.is_open, false)
  assert.equal(gap.opens_at, '11:00 AM')

  const broken = { wed_enabled: true, wed_start: null, wed_end: null }
  assert.equal(deriveStatusFromSchool(broken, at('12:00')).hours, 'Hours unavailable')
  assert.equal(deriveStatusFromSchool(broken, at('12:00')).is_open, false)
})

// ── Menus ───────────────────────────────────────────────────────────────────

test('mealSlugsForSchool and locationKind: explicit menu types, explicit none, and the legacy fallback', () => {
  assert.deepEqual(mealSlugsForSchool(tower), ['dinner', 'breakfast', 'lunch'])
  assert.deepEqual(mealSlugsForSchool(campusCenter), [])
  assert.deepEqual(mealSlugsForSchool({ name: 'Old district' }), ['breakfast', 'lunch', 'dinner', 'everyday'])
  assert.equal(locationKind(tower), 'dining-hall')
  assert.equal(locationKind(campusCenter), 'retail')
})

test('shouldSkipSection drops condiment-style stations only', () => {
  for (const name of ['Grill Condiments', 'Toppings', 'Garnishes', 'Beverages', 'Sauces', 'Coffee Creamer']) {
    assert.equal(shouldSkipSection(name), true, name)
  }
  for (const name of ['Daily Grill', 'Salad Bar', 'Dessert', 'Homestyle', 'Innovation']) {
    assert.equal(shouldSkipSection(name), false, name)
  }
})

test('ingestMenuStations keeps stations in order, skips condiments and dedupes repeated foods', () => {
  const seen = new Set()
  const stations = ingestMenuStations(LUNCH_ROWS, 'lunch', seen)
  assert.deepEqual(
    stations.map((s) => s.name),
    ['Homestyle', 'Daily Grill', 'Pizza', 'Hasta La Pasta', 'Salad Bar', 'Dessert', 'Innovation'],
  )
  const grill = stations.find((s) => s.name === 'Daily Grill')
  assert.deepEqual(grill.items[0], { name: 'Silver Star Burger', calories: 190, icons: ['Avoiding Gluten', 'Good Source of Protein'], meal: 'lunch' })
  // "Crushed Red Pepper" is listed under Pizza and again under Hasta La Pasta; it stays with the first.
  assert.ok(stations.find((s) => s.name === 'Pizza').items.some((i) => i.name === 'Crushed Red Pepper'))
  assert.ok(!stations.find((s) => s.name === 'Hasta La Pasta').items.some((i) => i.name === 'Crushed Red Pepper'))
  // 22 foods in the fixture, minus the three condiments, minus the repeated pepper.
  assert.equal(stations.reduce((n, s) => n + s.items.length, 0), 18)
  // The same rows for a second meal add nothing: every food is already seen.
  assert.deepEqual(ingestMenuStations(LUNCH_ROWS, 'dinner', seen), [])
  assert.deepEqual(ingestMenuStations(null, 'lunch'), [])
})

test('pickSchools resolves the two known halls in LOCATION_FILTERS order and reports what is missing', () => {
  const picked = pickSchools(SCHOOLS)
  assert.deepEqual(picked.map((p) => p.school.slug), ['tower-dining', 'campus-center'])
  assert.deepEqual(picked.map((p) => p.spec.id), LOCATION_FILTERS.map((f) => f.id))
  assert.deepEqual(pickSchools([campusCenter]).map((p) => p.school.slug), ['campus-center'])
  assert.deepEqual(pickSchools([]), [])
})

// ── Snapshot ────────────────────────────────────────────────────────────────

test('buildDiningBase fetches menus for the dining hall only, and renderSnapshot shapes both locations', async () => {
  const { fetchImpl, calls } = stubFetch(liveDistrict)
  const base = await buildDiningBase(SCHOOLS, '2026-09-09', { fetchImpl })
  // Tower publishes dinner, breakfast and lunch: three menu requests. The
  // Campus Center publishes nothing, so nothing is asked for it.
  assert.equal(calls.length, 3)
  assert.ok(calls.every((u) => u.includes('/tower-dining/menu-type/') && u.endsWith('/2026/9/9/?format=json')))
  assert.ok(calls.every((u) => u.startsWith('https://iupui.api.nutrislice.com/')))
  assert.deepEqual(base.missing, [])

  const snap = renderSnapshot(base, at('12:00'))
  assert.equal(snap.ok, true)
  assert.equal(snap.date, '2026-09-09')
  assert.equal(snap.weekday, 'Wednesday')
  assert.equal(snap.timezone, 'America/Indiana/Indianapolis')
  const [t, cc] = snap.locations
  assert.equal(t.slug, 'tower-dining')
  assert.equal(t.kind, 'dining-hall')
  assert.equal(t.address, 'University Tower, 911 W North St, Indianapolis, IN 46202')
  assert.equal(t.is_open, true)
  assert.equal(t.closes_at, '9:00 PM')
  assert.equal(t.menusPublished, true)
  assert.equal(t.meal, 'Menus: lunch')
  assert.equal(t.stations.length, 7)
  assert.equal(t.weekly_hours.Wednesday, '7:00 AM - 9:00 PM')
  assert.equal(t.warnings, undefined)
  assert.equal(cc.slug, 'campus-center')
  assert.equal(cc.kind, 'retail')
  assert.equal(cc.address, '420 University Blvd, Indianapolis, IN 46202')
  assert.equal(cc.menusPublished, false)
  assert.equal(cc.meal, RETAIL_MENU_NOTE)
  assert.deepEqual(cc.stations, [])
  assert.equal(cc.is_open, true)
})

test('a dining hall with no menu today says so, and a failing meal becomes a warning', async () => {
  const { fetchImpl } = stubFetch((url) => (url.includes('/menu-type/breakfast/') ? 500 : 404))
  const base = await buildDiningBase(SCHOOLS, '2026-09-09', { fetchImpl })
  const [t] = renderSnapshot(base, at('12:00')).locations
  assert.equal(t.menusPublished, false)
  assert.equal(t.meal, NO_MENU_NOTE)
  assert.deepEqual(t.stations, [])
  assert.deepEqual(t.warnings, ['menu_breakfast_500'])
})

// ── Cache ───────────────────────────────────────────────────────────────────

test('getDiningSnapshot caches the menus but recomputes open/closed on every read', async () => {
  const { fetchImpl, calls } = stubFetch(liveDistrict)
  const noon = await getDiningSnapshot({ now: at('12:00'), fetchImpl })
  assert.equal(noon.ok, true)
  assert.equal(noon.cached, false)
  assert.equal(calls.length, 4) // schools + three Tower meals
  assert.equal(noon.locations[0].is_open, true)
  assert.equal(noon.fetchedAt, at('12:00').toISOString())

  const evening = await getDiningSnapshot({ now: at('21:30'), fetchImpl })
  assert.equal(evening.cached, true)
  assert.equal(evening.stale, false)
  assert.equal(calls.length, 4) // no new upstream traffic
  assert.equal(evening.locations[0].is_open, false) // status followed the clock
  assert.equal(evening.locations[0].stations.length, 7)
  assert.equal(evening.fetchedAt, noon.fetchedAt)
})

test('getDiningSnapshot refreshes when the Indianapolis date rolls over, on forceRefresh, and for another date', async () => {
  const { fetchImpl, calls } = stubFetch(liveDistrict)
  await getDiningSnapshot({ now: at('12:00'), fetchImpl })
  assert.equal(calls.length, 4)

  const nextDay = await getDiningSnapshot({ now: at('08:00', '2026-09-10'), fetchImpl })
  assert.equal(nextDay.cached, false)
  assert.equal(nextDay.date, '2026-09-10')
  assert.equal(nextDay.weekday, 'Thursday')
  assert.equal(calls.length, 8)
  assert.ok(calls.slice(4).some((u) => u.endsWith('/2026/9/10/?format=json')))

  await getDiningSnapshot({ now: at('09:00', '2026-09-10'), fetchImpl, forceRefresh: true })
  assert.equal(calls.length, 12)

  const other = await getDiningSnapshot({ now: at('09:30', '2026-09-10'), fetchImpl, date: '2026-09-11' })
  assert.equal(other.date, '2026-09-11')
  assert.equal(other.cached, false)
  assert.equal(calls.length, 16)
})

test('an outage keeps serving the last good snapshot as stale and retries after a few minutes', async () => {
  // A one-hour TTL, so the 08:00 entry has expired by 10:00, when Nutrislice is down.
  process.env.NUTRISLICE_CACHE_MS = String(60 * 60 * 1000)
  let down = false
  const { fetchImpl, calls } = stubFetch((url) => (down ? 503 : liveDistrict(url)))
  await getDiningSnapshot({ now: at('08:00'), fetchImpl })
  assert.equal(calls.length, 4)
  down = true

  const stale = await getDiningSnapshot({ now: at('10:00'), fetchImpl })
  assert.equal(stale.ok, true)
  assert.equal(stale.stale, true)
  assert.equal(stale.cached, true)
  assert.equal(stale.locations[0].stations.length, 7)
  assert.equal(stale.locations[0].is_open, true)
  assert.equal(calls.length, 5) // one failed schools call

  const soon = await getDiningSnapshot({ now: new Date(at('10:00').getTime() + FAILURE_RETRY_MS - 1000), fetchImpl })
  assert.equal(soon.stale, true)
  assert.equal(calls.length, 5) // inside the retry hold-off: no upstream call

  down = false
  const recovered = await getDiningSnapshot({ now: new Date(at('10:00').getTime() + FAILURE_RETRY_MS + 1000), fetchImpl })
  assert.equal(recovered.stale, false)
  assert.equal(recovered.cached, false)
  assert.equal(calls.length, 9)
})

test('an outage with nothing cached answers ok:false and is retried after a few minutes, not twelve hours', async () => {
  let down = true
  const { fetchImpl, calls } = stubFetch((url) => (down ? 503 : liveDistrict(url)))
  const failed = await getDiningSnapshot({ now: at('08:00'), fetchImpl })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'schools_fetch_failed')
  assert.equal(failed.status, 503)
  assert.equal(failed.date, '2026-09-09')
  assert.equal(failed.weekday, 'Wednesday')
  assert.deepEqual(failed.locations, [])
  assert.equal(failed.cacheTtlMs, FAILURE_RETRY_MS)

  const again = await getDiningSnapshot({ now: at('08:01'), fetchImpl })
  assert.equal(again.ok, false)
  assert.equal(again.cached, true)
  assert.equal(calls.length, 1)

  down = false
  const back = await getDiningSnapshot({ now: new Date(at('08:00').getTime() + FAILURE_RETRY_MS + 1000), fetchImpl })
  assert.equal(back.ok, true)
  assert.equal(back.locations.length, 2)
})

test('NUTRISLICE_API_BASE points every request at another district', async () => {
  process.env.NUTRISLICE_API_BASE = 'https://example.test/nutrislice/'
  const { fetchImpl, calls } = stubFetch(liveDistrict)
  await getDiningSnapshot({ now: at('12:00'), fetchImpl })
  assert.ok(calls.every((u) => u.startsWith('https://example.test/nutrislice/menu/api/')))
})
