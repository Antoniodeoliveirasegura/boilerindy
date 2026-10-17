// Tests for the dining module (issue #119). The core is pure: Nutrislice rows
// from the saved fixtures go in, normalized locations with a live open/closed
// status come out. The fetch shell and the cache run against an injected
// fetch and a fixed clock, so no network and no dependence on the real time.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  FAILURE_RETRY_MS,
  HOURS_NOT_LISTED,
  LOCATION_FILTERS,
  MAX_CACHE_DATES,
  MIN_REFRESH_INTERVAL_MS,
  NO_MENU_NOTE,
  RETAIL_MENU_NOTE,
  __resetDiningCacheForTests,
  buildDiningBase,
  clampDiningDate,
  EVERYDAY_MIN_OTHER_DAYS,
  EVERYDAY_MIN_OVERLAP,
  deriveStatusFromSchool,
  everydayStations,
  extractWeeklyHours,
  formatClock12,
  getDiningSnapshot,
  hasPublishedFood,
  ingestMenuStations,
  locationKind,
  mealSlugsForSchool,
  pickSchools,
  renderSnapshot,
  shouldSkipSection,
  stationFoods,
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
// Tower's real lunch week of Sunday 2026-10-11 to Saturday 2026-10-17, trimmed
// to a few stations and foods a day: a menu on all seven days, weekends
// included, while the school rows flag Saturday and Sunday closed (issue #465).
const WEEKEND_LUNCH = load('nutrislice-tower-lunch-weekend.json')
// Breakfast for the same week: Breakfast Entree Line on weekdays (it rotates)
// and Grill Breakfast Options every day (it does not).
const WEEKEND_BREAKFAST = load('nutrislice-tower-breakfast-weekend.json')
const ALL_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Indianapolis is UTC-4 in September and October; 2026-09-09 is a Wednesday
// and 2026-10-17 a Saturday.
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

const schoolsCalls = (calls) => calls.filter((u) => u.includes('/menu/api/schools/')).length

const plusDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
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

test('clampDiningDate accepts yesterday through today + 14 on the Indianapolis calendar and nothing else', () => {
  const noon = at('12:00')
  for (const ymd of ['2026-09-09', '2026-09-08', '2026-09-23']) {
    assert.deepEqual(clampDiningDate(ymd, noon), { ok: true, ymd }, ymd)
  }
  for (const bad of ['2026-09-07', '2026-09-24', '2026-13-01', '2026-9-9', 'tomorrow', '', undefined, ['2026-09-09']]) {
    assert.deepEqual(clampDiningDate(bad, noon), { ok: false }, String(bad))
  }
  // 23:30 in Indianapolis is already the next day in UTC; the window still counts from 2026-09-09.
  const lateEvening = at('23:30')
  assert.equal(clampDiningDate('2026-09-08', lateEvening).ok, true)
  assert.equal(clampDiningDate('2026-09-24', lateEvening).ok, false)
  // The window crosses a year end, and an impossible date that would roll into it is still refused.
  const christmas = at('12:00', '2026-12-25')
  assert.equal(clampDiningDate('2027-01-08', christmas).ok, true)
  assert.equal(clampDiningDate('2027-01-09', christmas).ok, false)
  assert.equal(clampDiningDate('2026-13-01', christmas).ok, false)
  assert.equal(clampDiningDate('2026-03-02', at('12:00', '2026-02-27')).ok, true)
  assert.equal(clampDiningDate('2026-02-30', at('12:00', '2026-02-27')).ok, false)
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

test('extractWeeklyHours reads the real Tower row: weekdays 7 to 9, weekends flagged closed', () => {
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

test('extractWeeklyHours: a day flagged closed that has a published menu reads "Hours not listed" (issue #465)', () => {
  assert.equal(HOURS_NOT_LISTED, 'Hours not listed')
  assert.deepEqual(extractWeeklyHours(tower, { menuWeekdays: ALL_WEEK }), {
    Sunday: 'Hours not listed',
    Monday: '7:00 AM - 9:00 PM',
    Tuesday: '7:00 AM - 9:00 PM',
    Wednesday: '7:00 AM - 9:00 PM',
    Thursday: '7:00 AM - 9:00 PM',
    Friday: '7:00 AM - 9:00 PM',
    Saturday: 'Hours not listed',
  })
  // Only the weekdays with a menu change: a closed Sunday with no menu stays Closed.
  const saturdayOnly = extractWeeklyHours(tower, { menuWeekdays: ['Saturday'] })
  assert.equal(saturdayOnly.Saturday, 'Hours not listed')
  assert.equal(saturdayOnly.Sunday, 'Closed')
  // A menu never overrides hours the feed does list.
  assert.equal(extractWeeklyHours(tower, { menuWeekdays: ['Monday'] }).Monday, '7:00 AM - 9:00 PM')
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

test('deriveStatusFromSchool: a day flagged closed with a published menu is "not known", not Closed (issue #465)', () => {
  // Saturday 2026-10-17, 12:30 PM: the live feed flags Saturday closed above a 96-item menu.
  const saturday = deriveStatusFromSchool(tower, at('12:30', '2026-10-17'), { menuWeekdays: ALL_WEEK })
  assert.deepEqual(saturday, {
    is_open: null,
    hours: 'Hours not listed',
    closes_at: null,
    opens_at: null,
    open24h: false,
    tz: 'America/Indiana/Indianapolis',
  })
  // Sunday the same, at any hour: no hours are invented.
  assert.equal(deriveStatusFromSchool(tower, at('06:00', '2026-10-18'), { menuWeekdays: ALL_WEEK }).is_open, null)
  // Without a menu that weekday is still Closed today.
  const noMenu = deriveStatusFromSchool(tower, at('12:30', '2026-10-17'), { menuWeekdays: ['Monday', 'Tuesday'] })
  assert.equal(noMenu.is_open, false)
  assert.equal(noMenu.hours, 'Closed today')
  // A weekday with listed hours keeps the normal rule, menu or not.
  const friday = deriveStatusFromSchool(tower, at('21:30', '2026-10-16'), { menuWeekdays: ALL_WEEK })
  assert.equal(friday.is_open, false)
  assert.equal(friday.hours, '7:00 AM - 9:00 PM')
  // Yesterday's window past midnight still wins in the early hours.
  const lateFriday = { fri_enabled: true, fri_start: '11:00:00', fri_end: '02:00:00' }
  assert.equal(deriveStatusFromSchool(lateFriday, at('01:00', '2026-10-17'), { menuWeekdays: ALL_WEEK }).is_open, true)
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
  const seen = new Map()
  const stations = ingestMenuStations(LUNCH_ROWS, 'lunch', seen)
  assert.deepEqual(
    stations.map((s) => s.name),
    ['Homestyle', 'Daily Grill', 'Pizza', 'Hasta La Pasta', 'Salad Bar', 'Dessert', 'Innovation'],
  )
  const grill = stations.find((s) => s.name === 'Daily Grill')
  assert.deepEqual(grill.items[0], { name: 'Silver Star Burger', calories: 190, icons: ['Avoiding Gluten', 'Good Source of Protein'], meals: ['lunch'] })
  // "Crushed Red Pepper" is listed under Pizza and again under Hasta La Pasta; it stays with the first.
  assert.ok(stations.find((s) => s.name === 'Pizza').items.some((i) => i.name === 'Crushed Red Pepper'))
  assert.ok(!stations.find((s) => s.name === 'Hasta La Pasta').items.some((i) => i.name === 'Crushed Red Pepper'))
  // 22 foods in the fixture, minus the three condiments, minus the repeated pepper.
  assert.equal(stations.reduce((n, s) => n + s.items.length, 0), 18)
  // The same rows for a second meal add nothing: every food is already seen,
  // and each one now records that it is served at dinner too (issue #253).
  assert.deepEqual(ingestMenuStations(LUNCH_ROWS, 'dinner', seen), [])
  assert.deepEqual(grill.items[0].meals, ['lunch', 'dinner'])
  // A repeat within one meal (the pepper) or a meal seen twice is not listed twice.
  assert.deepEqual(ingestMenuStations(LUNCH_ROWS, 'dinner', seen), [])
  const pepper = stations.find((s) => s.name === 'Pizza').items.find((i) => i.name === 'Crushed Red Pepper')
  assert.deepEqual(pepper.meals, ['lunch', 'dinner'])
  assert.deepEqual(ingestMenuStations(null, 'lunch'), [])
})

test('hasPublishedFood counts the foods ingestMenuStations would show, not condiment-only days', () => {
  assert.equal(hasPublishedFood(LUNCH_ROWS), true)
  for (const day of WEEKEND_LUNCH.days) assert.equal(hasPublishedFood(day.menu_items), true, day.date)
  assert.equal(hasPublishedFood(TOWER_LUNCH.days.find((d) => d.date === '2026-09-08').menu_items), false)
  const condimentsOnly = WEEKEND_LUNCH.days[6].menu_items.filter((row, i, rows) => {
    const header = rows.slice(0, i + 1).filter((r) => r.is_section_title || r.is_station_header).pop()
    return header?.text === 'Grill Condiments'
  })
  assert.equal(condimentsOnly[0].text, 'Grill Condiments')
  assert.ok(condimentsOnly.some((row) => row.food))
  assert.equal(hasPublishedFood(condimentsOnly), false)
  assert.equal(hasPublishedFood([]), false)
  assert.equal(hasPublishedFood(null), false)
})

test('stationFoods keys each station\'s foods by id and leaves out condiment sections', () => {
  const saturday = stationFoods(WEEKEND_LUNCH.days.find((d) => d.date === '2026-10-17').menu_items)
  assert.deepEqual([...saturday.keys()], ['Daily Grill', 'Chef Made Soups', 'Dessert'])
  assert.equal(saturday.get('Daily Grill').size, 3)
  assert.ok([...saturday.get('Daily Grill')].every((key) => /^id:\d+$/.test(key)))
  assert.equal(stationFoods(null).size, 0)
})

test('everydayStations: the real week tells the stations that repeat from the ones that rotate (issue #466)', () => {
  assert.equal(EVERYDAY_MIN_OVERLAP, 0.6)
  assert.equal(EVERYDAY_MIN_OTHER_DAYS, 2)
  // Lunch: the grill serves the same food all week; soups, desserts and the
  // weekday Homestyle line change daily.
  assert.deepEqual([...everydayStations(WEEKEND_LUNCH.days, '2026-10-14')], ['Daily Grill'])
  assert.deepEqual([...everydayStations(WEEKEND_LUNCH.days, '2026-10-17')], ['Daily Grill'])
  // Breakfast: the grill options repeat, the entree line rotates.
  assert.deepEqual([...everydayStations(WEEKEND_BREAKFAST.days, '2026-10-14')], ['Grill Breakfast Options'])
  assert.deepEqual([...everydayStations(WEEKEND_BREAKFAST.days, '2026-10-17')], ['Grill Breakfast Options'])
  // A date outside the week has no stations to judge.
  assert.equal(everydayStations(WEEKEND_LUNCH.days, '2026-10-18').size, 0)
  assert.equal(everydayStations(null, '2026-10-14').size, 0)
})

test('everydayStations: the median overlap and the two-day minimum decide', () => {
  const header = (text) => ({ is_section_title: true, is_station_header: true, text, food: null })
  const food = (id) => ({ is_section_title: false, is_station_header: false, text: '', food: { id, name: `Food ${id}` } })
  const day = (date, stations) => ({
    date,
    menu_items: Object.entries(stations).flatMap(([name, ids]) => [header(name), ...ids.map(food)]),
  })
  const week = [
    // Grill: identical on every day. Special: new food daily. Edge: three of five
    // shared with each other day (overlap 0.6, every day). Short: one other day only.
    day('2026-10-12', { Grill: [1, 2], Special: [10], Edge: [20, 21, 22, 23, 24], Short: [40], Condiments: [50] }),
    day('2026-10-13', { Grill: [1, 2], Special: [11], Edge: [20, 21, 22, 23, 24], Short: [40] }),
    day('2026-10-14', { Grill: [1, 2], Special: [12], Edge: [20, 21, 22, 25, 26] }),
    day('2026-10-15', { Grill: [1, 2], Special: [13], Edge: [20, 21, 22, 27, 28] }),
  ]
  // Edge on 10-15 against 10-12, 10-13, 10-14: 3 shared of 7 distinct each, median 3/7, under 0.6.
  assert.deepEqual([...everydayStations(week, '2026-10-15')].sort(), ['Grill'])
  // Edge on 10-12: 1.0 (10-13), 3/7 (10-14), 3/7 (10-15): median 3/7, still rotating.
  assert.deepEqual([...everydayStations(week, '2026-10-12')].sort(), ['Grill'])
  // Exactly 0.6 counts: four shared of five distinct with each other day.
  const sixty = [
    day('2026-10-12', { Edge: [1, 2, 3, 4] }),
    day('2026-10-13', { Edge: [1, 2, 3, 5] }),
    day('2026-10-14', { Edge: [1, 2, 3, 6] }),
  ]
  assert.equal(3 / 5, 0.6)
  assert.deepEqual([...everydayStations(sixty, '2026-10-12')], ['Edge'])
  // A station on only one other day is not judged every day, and condiments never appear.
  assert.ok(!everydayStations(week, '2026-10-12').has('Short'))
  assert.ok(!everydayStations(week, '2026-10-12').has('Condiments'))
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
  assert.deepEqual(t.stations[1].items[0], { name: 'Silver Star Burger', calories: 190, icons: ['Avoiding Gluten', 'Good Source of Protein'], meals: ['lunch'] })
  assert.equal(t.weekly_hours.Wednesday, '7:00 AM - 9:00 PM')
  assert.equal(t.warnings, undefined)
  // Per-meal menus (issue #466). One day of food in this fixture's week, so
  // there is nothing to compare with and no station counts as every day.
  assert.deepEqual(t.menus.map((m) => m.meal), ['lunch'])
  assert.equal(t.menus[0].stations.length, 7)
  assert.ok(t.menus[0].stations.every((s) => s.everyday === false))
  assert.deepEqual(t.menus[0].stations[1].items[0], { name: 'Silver Star Burger', calories: 190, icons: ['Avoiding Gluten', 'Good Source of Protein'] })
  assert.equal(cc.slug, 'campus-center')
  assert.equal(cc.kind, 'retail')
  assert.equal(cc.address, '420 University Blvd, Indianapolis, IN 46202')
  assert.equal(cc.menusPublished, false)
  assert.equal(cc.meal, RETAIL_MENU_NOTE)
  assert.deepEqual(cc.stations, [])
  assert.deepEqual(cc.menus, [])
  assert.equal(cc.is_open, true)
})

test('each meal is its own menu, in serving order, with every-day stations learnt from the week (issue #466)', async () => {
  // Dinner for the same week: lunch's rows with one dessert swapped for a
  // dinner-only one. Nutrislice lists the menu types dinner, breakfast, lunch;
  // the snapshot serves them in order.
  const weekendDinner = structuredClone(WEEKEND_LUNCH)
  for (const day of weekendDinner.days) {
    for (const row of day.menu_items) {
      if (row.food && row.food.name === 'Banana Pudding') row.food = { ...row.food, id: 999001, name: 'Dinner Only Cake' }
    }
  }
  const { fetchImpl, calls } = stubFetch((url) => {
    if (url.includes('/menu-type/breakfast/')) return WEEKEND_BREAKFAST
    if (url.includes('/menu-type/lunch/')) return WEEKEND_LUNCH
    if (url.includes('/menu-type/dinner/')) return weekendDinner
    return 404
  })
  const base = await buildDiningBase(SCHOOLS, '2026-10-14', { fetchImpl })
  assert.ok(calls[0].includes('/menu-type/dinner/'), 'dinner is still fetched first')
  const [t] = renderSnapshot(base, at('12:30', '2026-10-14')).locations

  assert.equal(t.meal, 'Menus: breakfast, lunch, dinner')
  assert.deepEqual(t.menus.map((m) => m.meal), ['breakfast', 'lunch', 'dinner'])
  const flags = (meal) => Object.fromEntries(t.menus.find((m) => m.meal === meal).stations.map((s) => [s.name, s.everyday]))
  assert.deepEqual(flags('breakfast'), { 'Breakfast Entree Line': false, 'Grill Breakfast Options': true })
  assert.deepEqual(flags('lunch'), { Homestyle: false, 'Daily Grill': true, 'Chef Made Soups': false, Dessert: false })

  // Deduped within a meal only: a lunch food that dinner serves too is in both.
  const names = (meal) => t.menus.find((m) => m.meal === meal).stations.flatMap((s) => s.items.map((i) => i.name))
  const grillLunch = t.menus.find((m) => m.meal === 'lunch').stations.find((s) => s.name === 'Daily Grill').items.map((i) => i.name)
  assert.ok(grillLunch.length > 0)
  for (const name of grillLunch) assert.ok(names('dinner').includes(name), name)
  // Per-meal items carry no `meals`; the deprecated flat list still does, merged.
  assert.ok(t.menus.every((m) => m.stations.every((s) => s.items.every((i) => !('meals' in i)))))
  const flatGrill = t.stations.find((s) => s.name === 'Daily Grill').items[0]
  assert.deepEqual(flatGrill.meals.sort(), ['dinner', 'lunch'])
  assert.ok(names('dinner').includes('Dinner Only Cake'))
  assert.ok(!names('lunch').includes('Dinner Only Cake'))
})

test('a weekend breakfast with only every-day stations has no specials (issue #466)', async () => {
  const { fetchImpl } = stubFetch((url) => (url.includes('/menu-type/breakfast/') ? WEEKEND_BREAKFAST : 404))
  const base = await buildDiningBase(SCHOOLS, '2026-10-17', { fetchImpl })
  const [t] = renderSnapshot(base, at('09:00', '2026-10-17')).locations
  assert.deepEqual(t.menus, [
    {
      meal: 'breakfast',
      stations: [{ name: 'Grill Breakfast Options', everyday: true, items: t.menus[0].stations[0].items }],
    },
  ])
  assert.equal(t.menus[0].stations[0].items.length, 2)
})

test('on a Saturday with a published menu, Tower reads "Hours not listed", never Closed (issue #465)', async () => {
  const { fetchImpl } = stubFetch((url) => {
    if (url.includes('/tower-dining/menu-type/lunch/')) return WEEKEND_LUNCH
    return 404
  })
  const base = await buildDiningBase(SCHOOLS, '2026-10-17', { fetchImpl })
  const snap = renderSnapshot(base, at('12:30', '2026-10-17'))
  assert.equal(snap.weekday, 'Saturday')
  const [t, cc] = snap.locations
  assert.equal(t.is_open, null)
  assert.equal(t.hours, HOURS_NOT_LISTED)
  assert.equal(t.opens_at, null)
  assert.equal(t.closes_at, null)
  assert.equal(t.menusPublished, true)
  assert.deepEqual(t.stations.map((s) => s.name), ['Daily Grill', 'Chef Made Soups', 'Dessert'])
  assert.deepEqual(t.weekly_hours, {
    Sunday: 'Hours not listed',
    Monday: '7:00 AM - 9:00 PM',
    Tuesday: '7:00 AM - 9:00 PM',
    Wednesday: '7:00 AM - 9:00 PM',
    Thursday: '7:00 AM - 9:00 PM',
    Friday: '7:00 AM - 9:00 PM',
    Saturday: 'Hours not listed',
  })
  assert.ok(!JSON.stringify(t).includes('Closed'))
  // The Campus Center publishes no menu, so the feed's flags stand for it.
  assert.equal(cc.is_open, false)
  assert.equal(cc.hours, 'Closed today')
  assert.equal(cc.weekly_hours.Saturday, 'Closed')

  // The same week on a weekday: the normal hours rule.
  const wednesday = renderSnapshot(base, at('12:30', '2026-10-14')).locations[0]
  assert.equal(wednesday.is_open, true)
  assert.equal(wednesday.closes_at, '9:00 PM')
})

test('a weekend day with no published menu still reads Closed today', async () => {
  // The same week with Saturday's and Sunday's menus withdrawn.
  const weekdaysOnly = {
    ...WEEKEND_LUNCH,
    days: WEEKEND_LUNCH.days.map((d) => (d.date === '2026-10-11' || d.date === '2026-10-17' ? { ...d, menu_items: [] } : d)),
  }
  const { fetchImpl } = stubFetch((url) => (url.includes('/tower-dining/menu-type/lunch/') ? weekdaysOnly : 404))
  const base = await buildDiningBase(SCHOOLS, '2026-10-16', { fetchImpl })
  const [t] = renderSnapshot(base, at('12:30', '2026-10-17')).locations
  assert.equal(t.is_open, false)
  assert.equal(t.hours, 'Closed today')
  assert.equal(t.weekly_hours.Saturday, 'Closed')
  assert.equal(t.weekly_hours.Sunday, 'Closed')
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

test('concurrent misses for one date share a single upstream crawl', async () => {
  const { fetchImpl, calls } = stubFetch(liveDistrict)
  // Hold every response until both visitors are waiting on the crawl.
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const gated = async (url, init) => {
    const answer = fetchImpl(url, init)
    await gate
    return answer
  }

  const first = getDiningSnapshot({ now: at('12:00'), fetchImpl: gated })
  const second = getDiningSnapshot({ now: at('12:00'), fetchImpl: gated })
  assert.equal(calls.length, 1) // one schools request in flight, not two
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(schoolsCalls(calls), 1)
  assert.equal(calls.length, 4) // schools + three Tower meals, once
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a.cached, false)
  assert.equal(b.fetchedAt, a.fetchedAt)
  assert.equal(b.locations[0].stations.length, 7)

  // The next visitor is served from the finished crawl.
  const third = await getDiningSnapshot({ now: at('12:05'), fetchImpl })
  assert.equal(third.cached, true)
  assert.equal(calls.length, 4)
})

test('each date has its own cache entry, so another date does not evict today', async () => {
  const { fetchImpl, calls } = stubFetch(liveDistrict)
  await getDiningSnapshot({ now: at('12:00'), fetchImpl })
  const tomorrow = await getDiningSnapshot({ now: at('12:01'), fetchImpl, date: '2026-09-10' })
  assert.equal(tomorrow.date, '2026-09-10')
  assert.equal(tomorrow.cached, false)
  assert.equal(schoolsCalls(calls), 2)

  const today = await getDiningSnapshot({ now: at('12:02'), fetchImpl })
  assert.equal(today.date, '2026-09-09')
  assert.equal(today.cached, true)
  const tomorrowAgain = await getDiningSnapshot({ now: at('12:03'), fetchImpl, date: '2026-09-10' })
  assert.equal(tomorrowAgain.cached, true)
  assert.equal(schoolsCalls(calls), 2)
})

test('the cache holds 16 dates and a 17th evicts the one written longest ago', async () => {
  assert.equal(MAX_CACHE_DATES, 16)
  const { fetchImpl, calls } = stubFetch(liveDistrict)
  const dates = Array.from({ length: MAX_CACHE_DATES + 1 }, (_, i) => plusDays('2026-09-08', i))
  for (const date of dates) await getDiningSnapshot({ now: at('12:00'), fetchImpl, date })
  assert.equal(schoolsCalls(calls), 17)

  // The newest and the second oldest are still cached.
  assert.equal((await getDiningSnapshot({ now: at('12:01'), fetchImpl, date: dates[16] })).cached, true)
  assert.equal((await getDiningSnapshot({ now: at('12:01'), fetchImpl, date: dates[1] })).cached, true)
  assert.equal(schoolsCalls(calls), 17)
  // The oldest was dropped for the 17th and crawls again.
  const oldest = await getDiningSnapshot({ now: at('12:01'), fetchImpl, date: dates[0] })
  assert.equal(oldest.cached, false)
  assert.equal(schoolsCalls(calls), 18)
})

test('forceRefresh is a hint: a date refetches at most once per MIN_REFRESH_INTERVAL_MS', async () => {
  assert.equal(MIN_REFRESH_INTERVAL_MS, 10 * 60 * 1000)
  const { fetchImpl, calls } = stubFetch(liveDistrict)
  const noon = at('12:00').getTime()
  const first = await getDiningSnapshot({ now: new Date(noon), fetchImpl })
  assert.equal(first.refreshed, undefined) // only a refresh request is told
  assert.equal(calls.length, 4)

  const early = await getDiningSnapshot({ now: new Date(noon + MIN_REFRESH_INTERVAL_MS - 1000), fetchImpl, forceRefresh: true })
  assert.equal(early.refreshed, false)
  assert.equal(early.cached, true)
  assert.equal(early.fetchedAt, first.fetchedAt)
  assert.equal(calls.length, 4) // held to the floor: no upstream call

  const later = await getDiningSnapshot({ now: new Date(noon + MIN_REFRESH_INTERVAL_MS + 1000), fetchImpl, forceRefresh: true })
  assert.equal(later.refreshed, true)
  assert.equal(later.cached, false)
  assert.equal(calls.length, 8)

  // The refetch restarts the floor: a burst of refreshes right after costs nothing.
  const soon = new Date(noon + MIN_REFRESH_INTERVAL_MS + 2000)
  const held = await Promise.all(Array.from({ length: 5 }, () => getDiningSnapshot({ now: soon, fetchImpl, forceRefresh: true })))
  assert.ok(held.every((s) => s.refreshed === false && s.cached === true))
  assert.equal(calls.length, 8)

  // Past the floor, a burst of refreshes still shares one crawl.
  const past = new Date(noon + 2 * MIN_REFRESH_INTERVAL_MS + 1000)
  const burst = await Promise.all(Array.from({ length: 5 }, () => getDiningSnapshot({ now: past, fetchImpl, forceRefresh: true })))
  assert.ok(burst.every((s) => s.refreshed === true && s.cached === false))
  assert.equal(calls.length, 12)
})

test('NUTRISLICE_API_BASE points every request at another district', async () => {
  process.env.NUTRISLICE_API_BASE = 'https://example.test/nutrislice/'
  const { fetchImpl, calls } = stubFetch(liveDistrict)
  await getDiningSnapshot({ now: at('12:00'), fetchImpl })
  assert.ok(calls.every((u) => u.startsWith('https://example.test/nutrislice/menu/api/')))
})
