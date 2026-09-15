// Prompt context for the campus assistant (issue #253). Groq's free tier
// meters tokens for the whole organisation, so the dining block keeps the
// current meal's menu for open locations only and the study hints ride along
// only when asked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DINING_ITEMS_PER_STATION,
  STUDY_HELP_DEADLINE_HOURS,
  buildDiningContext,
  mealsForPrompt,
  startsWithin,
  wantsStudyHelp,
} from '../src/assistantContext.mjs'
import { buildDiningBase, renderSnapshot } from '../src/nutrisliceDining.mjs'

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const item = (name, extra = {}) => ({ name, calories: 320, icons: [], ...extra })

// Indianapolis is UTC-4 in September; 2026-09-09 is a Wednesday.
const at = (hhmm) => new Date(`2026-09-09T${hhmm}:00-04:00`)

test('open locations list stations, capped per station, diet tags kept and calories dropped', () => {
  const ctx = buildDiningContext({
    ok: true,
    date: '2026-09-09',
    locations: [
      {
        name: 'Tower Dining',
        is_open: true,
        hours: '7:00 AM - 9:00 PM',
        closes_at: '9:00 PM',
        stations: [
          {
            name: 'Daily Grill',
            items: [
              item('Veggie Burger', { icons: ['Vegetarian', 'Contains Soy'] }),
              item('Silver Star Burger', { icons: ['Avoiding Gluten'] }),
              item('Fries', { icons: ['Vegan', 'Vegetarian'] }),
              item('Grilled Chicken'),
              item('Hot Dog'),
              item('Onion Rings'),
              item('Chicken Tenders'),
            ],
          },
          { name: 'Empty Station', items: [] },
        ],
      },
    ],
  })
  assert.equal(
    ctx,
    [
      '=== DINING TODAY (2026-09-09) ===',
      'Tower Dining: OPEN until 9:00 PM',
      '  Daily Grill: Veggie Burger (Vegetarian), Silver Star Burger (Avoiding Gluten), Fries (Vegan/Vegetarian), Grilled Chicken, Hot Dog',
    ].join('\n'),
  )
  assert.equal(DINING_ITEMS_PER_STATION, 5)
  assert.doesNotMatch(ctx, /cal\b|320/)
})

test('closed locations are one line, with the opening time when there is one', () => {
  const stations = [{ name: 'Pizza', items: [item('Cheese Pizza')] }]
  const ctx = buildDiningContext({
    ok: true,
    date: '2026-09-09',
    locations: [
      { name: 'Tower Dining', is_open: false, hours: '4:30 PM - 9:00 PM', opens_at: '4:30 PM', stations },
      { name: 'Campus Center', is_open: false, hours: 'Closed today', opens_at: null, stations: [], meal: 'Retail dining, no posted menu' },
    ],
  })
  assert.equal(ctx, '=== DINING TODAY (2026-09-09) ===\nTower Dining: CLOSED - opens 4:30 PM\nCampus Center: CLOSED')
})

test('an open location without stations keeps its menu hint; 24-hour days keep their label', () => {
  const ctx = buildDiningContext({
    ok: true,
    date: '2026-09-09',
    locations: [
      { name: 'Campus Center', is_open: true, hours: '7:00 AM - 9:00 PM', closes_at: '9:00 PM', stations: [], meal: 'Retail dining, no posted menu' },
      { name: 'Library Cafe', is_open: true, hours: 'Open 24 hours', closes_at: null, open24h: true, stations: [] },
    ],
  })
  assert.equal(
    ctx,
    '=== DINING TODAY (2026-09-09) ===\nCampus Center: OPEN until 9:00 PM\n  Retail dining, no posted menu\nLibrary Cafe: OPEN - Open 24 hours',
  )
})

test('no usable snapshot means no dining block', () => {
  assert.equal(buildDiningContext(null), '')
  assert.equal(buildDiningContext({ ok: false, locations: [] }), '')
  assert.equal(buildDiningContext({ ok: true, date: '2026-09-09', locations: [] }), '')
})

test('the saved Nutrislice district renders menus at lunch and one line per hall at night', async () => {
  const schools = load('nutrislice-schools.json')
  const towerLunch = load('nutrislice-tower-lunch.json')
  const ccLunch = load('nutrislice-campus-center-lunch.json')
  const fetchImpl = async (url) => {
    if (url.includes('/tower-dining/menu-type/lunch/')) return { ok: true, status: 200, json: async () => towerLunch }
    if (url.includes('/campus-center/')) return { ok: true, status: 200, json: async () => ccLunch }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const base = await buildDiningBase(schools, '2026-09-09', { fetchImpl })

  const lunch = buildDiningContext(renderSnapshot(base, at('12:00')), { now: at('12:00') })
  assert.match(lunch, /^Tower Dining: OPEN until 9:00 PM \(lunch menu\)$/m)
  assert.match(lunch, /^ {2}Daily Grill: Silver Star Burger \(Avoiding Gluten\), Veggie Burger \(Vegetarian\)/m)
  assert.match(lunch, /^Campus Center: OPEN until 9:00 PM\n {2}Retail dining, no posted menu$/m)

  const early = buildDiningContext(renderSnapshot(base, at('06:00')), { now: at('06:00') })
  assert.equal(early, '=== DINING TODAY (2026-09-09) ===\nTower Dining: CLOSED - opens 7:00 AM\nCampus Center: CLOSED - opens 7:00 AM')

  const late = buildDiningContext(renderSnapshot(base, at('22:30')), { now: at('22:30') })
  assert.equal(late, '=== DINING TODAY (2026-09-09) ===\nTower Dining: CLOSED\nCampus Center: CLOSED')
  assert.ok(late.length < lunch.length / 5)
})

test('a hall that posts dinner before lunch lists the meal being served, or the one the question names', async () => {
  // Nutrislice lists Tower's menu types as dinner, breakfast, lunch, so dinner
  // is fetched first and a station shared by both meals starts with dinner
  // food. Here dinner has its own Homestyle entrees and the same Daily Grill.
  const schools = load('nutrislice-schools.json')
  const towerLunch = load('nutrislice-tower-lunch.json')
  const towerDinner = structuredClone(towerLunch)
  const dinnerDay = towerDinner.days.find((d) => d.date === '2026-09-09')
  const homestyle = dinnerDay.menu_items.findIndex((r) => r.text === 'Homestyle')
  const dinnerFoods = ['Turkey Tamale Pie', 'Vegetable Paella', 'Brown Sugar Mashed Sweet Potatoes', 'Steamed Green Beans', 'Corn Esquites']
  dinnerDay.menu_items.splice(
    homestyle + 1,
    3,
    ...dinnerFoods.map((name, i) => ({ food: { id: 9000001 + i, name, icons: { food_icons: [] }, rounded_nutrition_info: {} } })),
  )
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('/tower-dining/menu-type/dinner/')) return { ok: true, status: 200, json: async () => towerDinner }
    if (url.includes('/tower-dining/menu-type/lunch/')) return { ok: true, status: 200, json: async () => towerLunch }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const base = await buildDiningBase(schools, '2026-09-09', { fetchImpl })
  assert.ok(calls[0].includes('/menu-type/dinner/'), 'dinner is fetched first')

  const context = (hhmm, question) => buildDiningContext(renderSnapshot(base, at(hhmm)), { now: at(hhmm), question })

  const lunch = context('12:00', 'plan my afternoon')
  assert.match(lunch, /^Tower Dining: OPEN until 9:00 PM \(lunch menu\)$/m)
  assert.match(lunch, /^ {2}Homestyle: Jalapeno Cheddar Sausage, Herb Roasted Wedge Potatoes \(Avoiding Gluten\/Vegan\/Vegetarian\), Mushroom Medley/m)
  assert.match(lunch, /^ {2}Daily Grill: Silver Star Burger/m)
  assert.doesNotMatch(lunch, /Turkey Tamale Pie/)

  const dinner = context('18:00', 'whats the play')
  assert.match(dinner, /^Tower Dining: OPEN until 9:00 PM \(dinner menu\)$/m)
  assert.match(dinner, /^ {2}Homestyle: Turkey Tamale Pie, Vegetable Paella, Brown Sugar Mashed Sweet Potatoes, Steamed Green Beans, Corn Esquites$/m)
  // Foods served at both meals are listed at both.
  assert.match(dinner, /^ {2}Daily Grill: Silver Star Burger/m)
  assert.doesNotMatch(dinner, /Jalapeno Cheddar Sausage/)

  // Naming a meal beats the clock.
  assert.match(context('12:00', "what's for dinner tonight?"), /\(dinner menu\)\n {2}Homestyle: Turkey Tamale Pie/)
  // No breakfast menu posted: every item is listed, with no meal label.
  const breakfast = context('08:00', 'breakfast?')
  assert.match(breakfast, /^Tower Dining: OPEN until 9:00 PM$/m)
  assert.match(breakfast, /^ {2}Homestyle: Turkey Tamale Pie/m)
})

test('mealsForPrompt goes by the Indianapolis clock unless the question names a meal', () => {
  assert.deepEqual(mealsForPrompt(at('07:00')), ['breakfast', 'brunch'])
  assert.deepEqual(mealsForPrompt(at('10:29')), ['breakfast', 'brunch'])
  assert.deepEqual(mealsForPrompt(at('10:30')), ['lunch', 'brunch'])
  assert.deepEqual(mealsForPrompt(at('16:29')), ['lunch', 'brunch'])
  assert.deepEqual(mealsForPrompt(at('16:30')), ['dinner'])
  assert.deepEqual(mealsForPrompt(at('23:59')), ['dinner'])
  assert.deepEqual(mealsForPrompt(at('00:30')), ['breakfast', 'brunch'])
  assert.deepEqual(mealsForPrompt(at('09:00'), 'Is LUNCH any good today'), ['lunch'])
  assert.deepEqual(mealsForPrompt(at('09:00'), 'lunchbox ideas'), ['breakfast', 'brunch'])
  // A weekend brunch menu is picked up at noon.
  const ctx = buildDiningContext(
    {
      ok: true,
      date: '2026-09-12',
      locations: [
        {
          name: 'Tower Dining',
          is_open: true,
          closes_at: '7:00 PM',
          stations: [{ name: 'Homestyle', items: [item('Waffles', { meals: ['brunch'] }), item('Pot Roast', { meals: ['dinner'] })] }],
        },
      ],
    },
    { now: at('12:00') },
  )
  assert.equal(ctx, '=== DINING TODAY (2026-09-12) ===\nTower Dining: OPEN until 7:00 PM (brunch menu)\n  Homestyle: Waffles')
})

test('startsWithin finds a deadline in the next 48 hours and ignores past or later ones', () => {
  const now = at('12:00')
  const row = (iso) => ({ start_time: iso })
  assert.equal(STUDY_HELP_DEADLINE_HOURS, 48)
  // Homework due tonight, and one due exactly 48 hours out.
  assert.equal(startsWithin([row('2026-09-09T23:59:00-04:00')], now), true)
  assert.equal(startsWithin([row('2026-09-11T12:00:00-04:00')], now), true)
  // Already past, a minute beyond the window, a missing or bad time, no rows.
  assert.equal(startsWithin([row('2026-09-09T11:00:00-04:00')], now), false)
  assert.equal(startsWithin([row('2026-09-11T12:01:00-04:00')], now), false)
  assert.equal(startsWithin([{}, row('not a date')], now), false)
  assert.equal(startsWithin([], now), false)
  assert.equal(startsWithin(null, now), false)
  // A narrower window.
  assert.equal(startsWithin([row('2026-09-10T12:00:00-04:00')], now, 12), false)
})

test('wantsStudyHelp matches study and help questions only', () => {
  for (const q of [
    'how do I get a quiet spot to study',
    'when is homework 3 due and where should I do it',
    'Where can I focus for an hour?',
    'is the library open late',
    'I have two exams on Friday',
    'any tutoring for calc?',
    'best place for studying between classes',
  ]) {
    assert.equal(wantsStudyHelp(q), true, q)
  }
  for (const q of [
    'whats the play',
    'plan my afternoon',
    "what's good for lunch today",
    "when's my next class",
    'anything happening on campus tonight?',
    'student discount on textbooks',
    '',
  ]) {
    assert.equal(wantsStudyHelp(q), false, q)
  }
  assert.equal(wantsStudyHelp(null), false)
  assert.equal(wantsStudyHelp(undefined), false)
})
