// Prompt context for the campus assistant (issue #253). Groq's free tier
// meters tokens for the whole organisation, so the dining block keeps menus
// for open locations only and the study hints ride along only when asked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { DINING_ITEMS_PER_STATION, buildDiningContext, wantsStudyHelp } from '../src/assistantContext.mjs'
import { buildDiningBase, renderSnapshot } from '../src/nutrisliceDining.mjs'

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const item = (name, extra = {}) => ({ name, calories: 320, icons: [], ...extra })

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

  // Indianapolis is UTC-4 in September.
  const lunch = buildDiningContext(renderSnapshot(base, new Date('2026-09-09T12:00:00-04:00')))
  assert.match(lunch, /^Tower Dining: OPEN until 9:00 PM$/m)
  assert.match(lunch, /^ {2}Daily Grill: Silver Star Burger \(Avoiding Gluten\), Veggie Burger \(Vegetarian\)/m)
  assert.match(lunch, /^Campus Center: OPEN until 9:00 PM\n {2}Retail dining, no posted menu$/m)

  const early = buildDiningContext(renderSnapshot(base, new Date('2026-09-09T06:00:00-04:00')))
  assert.equal(early, '=== DINING TODAY (2026-09-09) ===\nTower Dining: CLOSED - opens 7:00 AM\nCampus Center: CLOSED - opens 7:00 AM')

  const late = buildDiningContext(renderSnapshot(base, new Date('2026-09-09T22:30:00-04:00')))
  assert.equal(late, '=== DINING TODAY (2026-09-09) ===\nTower Dining: CLOSED\nCampus Center: CLOSED')
  assert.ok(late.length < lunch.length / 5)
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
