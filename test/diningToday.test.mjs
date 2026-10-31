import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_HEADLINERS,
  buildDiningToday,
  findHall,
  findNextOpening,
  getDiningToday,
  headlinersOf,
  mealStretches,
  normalizeHall,
  parseHoursLabel,
} from '../src/diningToday.mjs'
import { HOURS_NOT_LISTED, buildDiningBase, renderSnapshot } from '../src/nutrisliceDining.mjs'

// Issue #549: one hall's day for the app's Dining widget, built from the
// snapshot /api/dining serves. The snapshots here go through the real
// buildDiningBase and renderSnapshot with the saved Nutrislice weeks, so a
// change to the snapshot's hours labels or menus shows up here.

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const SCHOOLS = load('nutrislice-schools.json')
// Tower's real week of Sunday 2026-10-11 to Saturday 2026-10-17: lunch and
// breakfast every day, while the school rows flag the weekend closed (#465).
const LUNCH = load('nutrislice-tower-lunch-weekend.json')
const BREAKFAST = load('nutrislice-tower-breakfast-weekend.json')
// Dinner for the same week, as the snapshot tests make it: lunch's rows with
// one dessert swapped for a dinner-only one.
const DINNER = structuredClone(LUNCH)
for (const day of DINNER.days) {
  for (const row of day.menu_items) {
    if (row.food && row.food.name === 'Banana Pudding') row.food = { ...row.food, id: 999001, name: 'Dinner Only Cake' }
  }
}
// A whole real lunch (2026-09-09, 22 foods in seven stations), for the size check.
const FULL_LUNCH = load('nutrislice-tower-lunch.json')

function fetchFrom(weeks) {
  return async (url) => {
    const meal = Object.keys(weeks).find((name) => url.includes(`/menu-type/${name}/`))
    return meal ? { ok: true, status: 200, json: async () => weeks[meal] } : { ok: false, status: 404, json: async () => ({}) }
  }
}
const WEEK = fetchFrom({ breakfast: BREAKFAST, lunch: LUNCH, dinner: DINNER })

// Indianapolis is UTC-4 in October; 2026-10-14 is a Wednesday.
const at = (hhmm, ymd) => new Date(`${ymd}T${hhmm}:00-04:00`)
async function snapshot(ymd, now, fetchImpl = WEEK) {
  return renderSnapshot(await buildDiningBase(SCHOOLS, ymd, { fetchImpl }), now)
}
const tower = (snap) => snap.locations.find((l) => l.slug === 'tower-dining')
const clock = (iso) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Indiana/Indianapolis', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))

test('a hall is named by its slug, or by its first word when that is not ambiguous', () => {
  const locations = [{ slug: 'tower-dining' }, { slug: 'campus-center' }]
  assert.equal(normalizeHall(' Tower '), 'tower')
  assert.equal(normalizeHall('tower dining'), null)
  assert.equal(normalizeHall(''), null)
  assert.equal(normalizeHall(['tower']), null)
  assert.equal(normalizeHall('x'.repeat(41)), null)
  assert.equal(findHall(locations, 'tower-dining').slug, 'tower-dining')
  assert.equal(findHall(locations, 'tower').slug, 'tower-dining')
  assert.equal(findHall(locations, 'campus').slug, 'campus-center')
  assert.equal(findHall(locations, 'center'), null)
  assert.equal(findHall(locations, 'tower-d'), null)
  assert.equal(findHall([...locations, { slug: 'tower-cafe' }], 'tower'), null, 'two halls start with tower')
  assert.equal(findHall(null, 'tower'), null)
})

test('hours labels read back as minutes, the way the snapshot writes them', async () => {
  assert.deepEqual(parseHoursLabel('7:00 AM - 9:00 PM'), { kind: 'hours', start: 420, end: 1260 })
  assert.deepEqual(parseHoursLabel('12:00 PM - 12:30 AM'), { kind: 'hours', start: 720, end: 30 })
  assert.deepEqual(parseHoursLabel('Open 24 hours'), { kind: 'allDay' })
  assert.deepEqual(parseHoursLabel(HOURS_NOT_LISTED), { kind: 'unknown' })
  assert.deepEqual(parseHoursLabel('Hours unavailable'), { kind: 'unknown' })
  assert.deepEqual(parseHoursLabel('Closed'), { kind: 'closed' })
  assert.deepEqual(parseHoursLabel(undefined), { kind: 'closed' })
  // Every label the real snapshot writes for Tower's week reads as hours or as not listed.
  const week = tower(await snapshot('2026-10-14', at('12:30', '2026-10-14'))).weekly_hours
  assert.deepEqual(Object.values(week).map((label) => parseHoursLabel(label).kind), ['unknown', 'hours', 'hours', 'hours', 'hours', 'hours', 'unknown'])
})

test('each meal gets one stretch of the day from the app\'s meal windows, cut to the hours', () => {
  const span = (rows) => rows.map(({ meal, from, until }) => [meal, from, until])
  assert.deepEqual(span(mealStretches(['breakfast', 'lunch', 'dinner'], 420, 1260)), [
    ['breakfast', 420, 630],
    ['lunch', 630, 990],
    ['dinner', 990, 1260],
  ])
  // Brunch stands in for breakfast and lunch.
  assert.deepEqual(span(mealStretches(['brunch', 'dinner'], 600, 1200)), [
    ['brunch', 600, 990],
    ['dinner', 990, 1200],
  ])
  // No breakfast: lunch from the opening, as Dining opens on lunch then.
  assert.deepEqual(span(mealStretches(['lunch', 'dinner'], 420, 1260)), [
    ['lunch', 420, 990],
    ['dinner', 990, 1260],
  ])
  // No dinner: the evening shows no meal rather than going back to breakfast.
  assert.deepEqual(span(mealStretches(['breakfast', 'lunch'], 420, 1260)), [
    ['breakfast', 420, 630],
    ['lunch', 630, 990],
  ])
  // A meal whose window is outside the hours has no stretch.
  assert.deepEqual(span(mealStretches(['breakfast', 'lunch', 'dinner'], 420, 900)), [
    ['breakfast', 420, 630],
    ['lunch', 630, 900],
    ['dinner', null, null],
  ])
  assert.deepEqual(mealStretches([]), [])
})

test('headliners are the first dish of each station not served every day, three at most', () => {
  assert.equal(MAX_HEADLINERS, 3)
  const menu = {
    stations: [
      { name: 'Daily Grill', everyday: true, items: [{ name: 'Burger' }] },
      { name: 'Homestyle', everyday: false, items: [{ name: 'Chicken Fried Steak' }, { name: 'Mashed Potatoes' }] },
      { name: 'Empty', everyday: false, items: [] },
      { name: 'Chef Made Soups', everyday: false, items: [{ name: 'Broccoli Cheddar Soup' }] },
      { name: 'Dessert', everyday: false, items: [{ name: 'Banana Pudding' }] },
      { name: 'Innovation', everyday: false, items: [{ name: 'Ramen' }] },
    ],
  }
  assert.deepEqual(headlinersOf(menu), [
    { station: 'Homestyle', dish: 'Chicken Fried Steak' },
    { station: 'Chef Made Soups', dish: 'Broccoli Cheddar Soup' },
    { station: 'Dessert', dish: 'Banana Pudding' },
  ])
  assert.deepEqual(headlinersOf(undefined), [])
})

test('Wednesday at lunch: open until 9 PM, three meals with their dishes, and tomorrow\'s breakfast next', async () => {
  const now = at('12:30', '2026-10-14')
  const today = await snapshot('2026-10-14', now)
  const tomorrow = await snapshot('2026-10-15', now)
  const soupAndDessert = [
    { station: 'Homestyle', dish: 'Honey Garlic Fried Chicken' },
    { station: 'Chef Made Soups', dish: 'Chicken Miso Soup' },
    { station: 'Dessert', dish: 'Chocolate Soft Serve Ice Cream' },
  ]
  assert.deepEqual(buildDiningToday(today, tower(today), now, { nextLocation: tower(tomorrow) }), {
    date: '2026-10-14',
    hall: { slug: 'tower-dining', name: 'Tower Dining', kind: 'dining-hall' },
    open: true,
    opensAt: '2026-10-14T11:00:00Z',
    closesAt: '2026-10-15T01:00:00Z',
    nextOpening: {
      date: '2026-10-15',
      at: '2026-10-15T11:00:00Z',
      meal: 'breakfast',
      headliners: [{ station: 'Breakfast Entree Line', dish: 'Scrambled Eggs' }],
    },
    meals: [
      {
        meal: 'breakfast',
        from: '2026-10-14T11:00:00Z',
        until: '2026-10-14T14:30:00Z',
        headliners: [{ station: 'Breakfast Entree Line', dish: 'Scrambled Eggs' }],
      },
      { meal: 'lunch', from: '2026-10-14T14:30:00Z', until: '2026-10-14T20:30:00Z', headliners: soupAndDessert },
      { meal: 'dinner', from: '2026-10-14T20:30:00Z', until: '2026-10-15T01:00:00Z', headliners: soupAndDessert },
    ],
  })
})

test('before opening, the next opening is this morning, with this morning\'s breakfast', async () => {
  const now = at('06:00', '2026-10-14')
  const today = await snapshot('2026-10-14', now)
  const answer = buildDiningToday(today, tower(today), now)
  assert.equal(answer.open, false)
  assert.equal(answer.opensAt, '2026-10-14T11:00:00Z')
  assert.deepEqual(answer.nextOpening, {
    date: '2026-10-14',
    at: '2026-10-14T11:00:00Z',
    meal: 'breakfast',
    headliners: [{ station: 'Breakfast Entree Line', dish: 'Scrambled Eggs' }],
  })
})

test('Friday night points at Saturday, whose hours are not listed though it has a menu (issue #465)', async () => {
  const now = at('22:00', '2026-10-16')
  const friday = await snapshot('2026-10-16', now)
  const saturday = await snapshot('2026-10-17', now)
  const answer = buildDiningToday(friday, tower(friday), now, { nextLocation: tower(saturday) })
  assert.equal(answer.open, false)
  // Saturday's breakfast is the every-day grill only, so it has no headliner.
  assert.deepEqual(answer.nextOpening, { date: '2026-10-17', at: null, meal: 'breakfast', headliners: [] })
  // Without Saturday's snapshot the time is still known to be unknown.
  assert.deepEqual(buildDiningToday(friday, tower(friday), now).nextOpening, { date: '2026-10-17', at: null, meal: null, headliners: [] })
})

test('on Saturday the day has no listed ends: no opening or closing, open-ended first and last meals', async () => {
  const now = at('12:30', '2026-10-17')
  const saturday = await snapshot('2026-10-17', now)
  const answer = buildDiningToday(saturday, tower(saturday), now)
  assert.equal(answer.open, null)
  assert.equal(answer.opensAt, null)
  assert.equal(answer.closesAt, null)
  assert.deepEqual(
    answer.meals.map(({ meal, from, until }) => [meal, from, until]),
    [
      ['breakfast', null, '2026-10-17T14:30:00Z'],
      ['lunch', '2026-10-17T14:30:00Z', '2026-10-17T20:30:00Z'],
      ['dinner', '2026-10-17T20:30:00Z', null],
    ],
  )
})

test('the answer agrees with /api/dining at the same moment, all day', async () => {
  for (const hhmm of ['00:30', '06:59', '07:00', '10:29', '10:30', '12:30', '16:30', '20:59', '21:00', '21:01', '23:59']) {
    const now = at(hhmm, '2026-10-14')
    const snap = await snapshot('2026-10-14', now)
    for (const location of snap.locations) {
      const answer = buildDiningToday(snap, location, now)
      assert.equal(answer.open, location.is_open, `${location.slug} ${hhmm}`)
      if (location.closes_at) assert.equal(clock(answer.closesAt), location.closes_at, `${location.slug} ${hhmm}`)
      if (location.opens_at) assert.equal(clock(answer.opensAt), location.opens_at, `${location.slug} ${hhmm}`)
      if (answer.open === false) assert.ok(Date.parse(answer.nextOpening.at) > now.getTime(), `${location.slug} ${hhmm}`)
    }
  }
})

test('the Campus Center, a food court with no menu, answers its hours and no meals', async () => {
  const now = at('12:30', '2026-10-14')
  const snap = await snapshot('2026-10-14', now)
  const cc = snap.locations.find((l) => l.slug === 'campus-center')
  assert.deepEqual(buildDiningToday(snap, cc, now), {
    date: '2026-10-14',
    hall: { slug: 'campus-center', name: 'Campus Center', kind: 'retail' },
    open: true,
    opensAt: '2026-10-14T11:00:00Z',
    closesAt: '2026-10-15T01:00:00Z',
    nextOpening: { date: '2026-10-15', at: '2026-10-15T11:00:00Z', meal: null, headliners: [] },
    meals: [],
  })
})

test('a window that runs past midnight counts from yesterday into the early hours', () => {
  const lateNight = Object.fromEntries(
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => [day, '11:00 AM - 2:00 AM']),
  )
  const location = { slug: 'late', name: 'Late Hall', kind: 'retail', is_open: true, weekly_hours: lateNight, menus: [] }
  const now = at('01:00', '2026-10-15')
  const answer = buildDiningToday({ date: '2026-10-15' }, location, now)
  assert.equal(answer.opensAt, '2026-10-14T15:00:00Z')
  assert.equal(answer.closesAt, '2026-10-15T06:00:00Z')
  // The next opening comes after this window closes.
  assert.equal(answer.nextOpening.at, '2026-10-15T15:00:00Z')
  // Nothing open within a week: no next opening.
  const shut = { ...location, is_open: false, weekly_hours: { Monday: 'Closed' } }
  assert.equal(findNextOpening(shut, '2026-10-15', now.getTime()), null)
})

test('a whole day at Tower stays well under 4 KB', async () => {
  const fullDay = fetchFrom({ breakfast: FULL_LUNCH, lunch: FULL_LUNCH, dinner: FULL_LUNCH })
  const now = at('12:00', '2026-09-09')
  const snap = await snapshot('2026-09-09', now, fullDay)
  const answer = buildDiningToday(snap, tower(snap), now, { nextLocation: tower(snap) })
  assert.equal(answer.meals.length, 3)
  assert.ok(answer.meals.every((m) => m.headliners.length === 3))
  const bytes = Buffer.byteLength(JSON.stringify(answer))
  assert.ok(bytes < 4096, `${bytes} bytes`)
})

test('getDiningToday reads today\'s snapshot, then the next opening\'s date for its first meal', async () => {
  const now = at('22:00', '2026-10-14')
  const byDate = { '2026-10-14': await snapshot('2026-10-14', now), '2026-10-15': await snapshot('2026-10-15', now) }
  const calls = []
  const getDiningSnapshot = async (options) => {
    calls.push(options)
    return byDate[options.date ?? '2026-10-14']
  }
  const { today } = await getDiningToday('tower', { getDiningSnapshot, now })
  assert.deepEqual(calls, [{}, { date: '2026-10-15' }])
  assert.equal(today.hall.slug, 'tower-dining')
  assert.equal(today.open, false)
  assert.deepEqual(today.nextOpening, {
    date: '2026-10-15',
    at: '2026-10-15T11:00:00Z',
    meal: 'breakfast',
    headliners: [{ station: 'Breakfast Entree Line', dish: 'Scrambled Eggs' }],
  })
  assert.deepEqual(await getDiningToday('nowhere', { getDiningSnapshot, now }), { today: null })
})

test('getDiningToday: no good snapshot is unavailable, and a failed next day only leaves its meal out', async (t) => {
  const outage = async () => ({ ok: false, error: 'schools_fetch_failed', locations: [] })
  assert.deepEqual(await getDiningToday('tower-dining', { getDiningSnapshot: outage }), { unavailable: true })

  const warn = t.mock.method(console, 'warn', () => {})
  const now = at('22:00', '2026-10-14')
  const today = await snapshot('2026-10-14', now)
  const flaky = async (options) => {
    if (options.date) throw new Error('Nutrislice timed out')
    return today
  }
  const answer = await getDiningToday('tower-dining', { getDiningSnapshot: flaky, now })
  assert.deepEqual(answer.today.nextOpening, { date: '2026-10-15', at: '2026-10-15T11:00:00Z', meal: null, headliners: [] })
  assert.equal(warn.mock.callCount(), 1)
})
