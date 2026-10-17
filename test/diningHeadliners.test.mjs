// Headliners and what is coming up (issue #469). The digest gives each
// weekday's headline dishes about six weeks out for 2.3 KB a week; the cached
// full week gives the rest of the current week exactly, weekends included.
// Network-free: an injected fetch answers the saved fixtures.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { DIGEST_MEALS, DIGEST_WEEKS, TENTATIVE_AFTER_DAYS, __resetDiningHeadlinersForTests, getDiningUpcoming, parseDigest } from '../src/diningHeadliners.mjs'
import { __resetDiningCacheForTests, weekSpecials } from '../src/nutrisliceDining.mjs'

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const SCHOOLS = load('nutrislice-schools.json')
const WEEKEND_LUNCH = load('nutrislice-tower-lunch-weekend.json')
// Tower's real lunch digest for the week of 2026-10-11: Monday to Friday, four dishes a day.
const DIGEST = load('nutrislice-tower-digest-lunch.json')

// Indianapolis is UTC-4 in October; 2026-10-14 is a Wednesday.
const at = (hhmm, ymd = '2026-10-14') => new Date(`${ymd}T${hhmm}:00-04:00`)

const plusDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// The digest of the week starting `sunday`: the real week shifted, its dishes
// renamed per week so each week is told apart.
function digestFor(sunday) {
  const shift = Math.round((Date.parse(`${sunday}T00:00:00Z`) - Date.parse('2026-10-11T00:00:00Z')) / 86_400_000)
  if (shift === 0) return DIGEST
  return DIGEST.map((day) => ({ ...day, date: plusDays(day.date, shift), menu_items: day.menu_items.map((name) => `${name} (week +${shift / 7})`) }))
}

function stubFetch({ digestDown = false } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const reply = (status, body) => ({ ok: status === 200, status, json: async () => body })
    if (url.includes('/menu/api/schools/')) return reply(200, SCHOOLS)
    const digest = /\/digest\/school\/tower-dining\/menu-type\/lunch\/date\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//.exec(url)
    if (digest) {
      if (digestDown) return reply(503, null)
      const sunday = `${digest[1]}-${digest[2].padStart(2, '0')}-${digest[3].padStart(2, '0')}`
      return reply(200, digestFor(sunday))
    }
    if (url.includes('/weeks/school/tower-dining/menu-type/lunch/')) return reply(200, WEEKEND_LUNCH)
    return reply(404, null)
  }
  return { fetchImpl, calls }
}

beforeEach(() => {
  __resetDiningCacheForTests()
  __resetDiningHeadlinersForTests()
  delete process.env.NUTRISLICE_CACHE_MS
})

test('parseDigest pairs each dish with its photo and drops anything that is not a day', () => {
  const days = parseDigest(DIGEST, 'lunch')
  assert.deepEqual(days.map((d) => d.date), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'])
  assert.equal(days[0].meal, 'lunch')
  assert.deepEqual(days[0].dishes[0], { name: 'Pasta Primavera', image: DIGEST[0].images[0] })
  assert.deepEqual(days[0].dishes[1], { name: 'Mushrooms, Tomatoes and Spinach', image: null })
  assert.equal(days[0].holiday, null)
  assert.deepEqual(parseDigest({ not: 'a list' }, 'lunch'), [])
  assert.deepEqual(parseDigest([{ date: '2026-10-12', menu_items: ['  ', 'Soup'], images: [], holiday_text: ' Fall break ' }], 'lunch'), [
    { date: '2026-10-12', meal: 'lunch', dishes: [{ name: 'Soup', image: null }], holiday: 'Fall break' },
  ])
})

test('weekSpecials lists the dishes that change day to day, for the rest of the week', async () => {
  const { fetchImpl } = stubFetch()
  const specials = await weekSpecials('2026-10-14', { now: at('12:00'), fetchImpl })
  assert.deepEqual(specials.map((s) => s.date), ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'])
  const wednesday = specials[0]
  assert.equal(wednesday.location, 'Tower Dining')
  assert.equal(wednesday.meal, 'lunch')
  // Homestyle, soups and desserts rotate; the grill does not, so it is not here.
  const names = wednesday.dishes.map((d) => d.name)
  assert.ok(names.includes('Honey Garlic Fried Chicken'))
  assert.ok(names.includes('Banana Pudding'))
  assert.ok(!names.includes('Silver Star Burger'))
})

test('getDiningUpcoming merges this week\'s specials with the digest\'s headliners, marking far days tentative', async () => {
  assert.deepEqual(DIGEST_MEALS, ['lunch', 'dinner'])
  assert.equal(DIGEST_WEEKS, 7)
  assert.equal(TENTATIVE_AFTER_DAYS, 7)
  const { fetchImpl, calls } = stubFetch()
  const up = await getDiningUpcoming({ now: at('12:00'), fetchImpl })
  assert.equal(up.ok, true)
  assert.equal(up.today, '2026-10-14')
  assert.equal(up.days[0].date, '2026-10-14')
  assert.ok(up.days.every((d) => d.date >= '2026-10-14'))

  const today = up.days[0]
  assert.equal(today.tentative, false)
  assert.equal(today.meals.length, 1)
  const lunch = today.meals[0]
  assert.equal(lunch.meal, 'lunch')
  assert.equal(lunch.location, 'Tower Dining')
  assert.deepEqual(lunch.headliners.map((h) => h.name), DIGEST[2].menu_items)
  assert.ok(lunch.specials.includes('Honey Garlic Fried Chicken'))

  // Saturday has the full week's specials and no digest; Sunday has neither.
  const saturday = up.days.find((d) => d.date === '2026-10-17')
  assert.deepEqual(saturday.meals[0].headliners, [])
  assert.ok(saturday.meals[0].specials.length > 0)
  assert.equal(up.days.find((d) => d.date === '2026-10-18'), undefined)

  // Next week from the digest: a week out is firm, beyond it tentative.
  const nextTuesday = up.days.find((d) => d.date === '2026-10-20')
  assert.equal(nextTuesday.tentative, false)
  assert.match(nextTuesday.meals[0].headliners[0].name, /\(week \+1\)$/)
  assert.deepEqual(nextTuesday.meals[0].specials, [])
  assert.equal(up.days.find((d) => d.date === '2026-10-21').tentative, false)
  assert.equal(up.days.find((d) => d.date === '2026-10-22').tentative, true)
  // Seven weeks of digest: the last weekday is in the week of 11-22.
  assert.equal(up.days.at(-1).date, '2026-11-27')

  // Lunch digests for seven weeks; dinner answered 404 here.
  assert.equal(calls.filter((u) => u.includes('/digest/') && u.includes('/lunch/')).length, 7)
  // A second read inside the cache period downloads no digest again.
  const before = calls.length
  await getDiningUpcoming({ now: at('12:30'), fetchImpl })
  assert.equal(calls.filter((u, i) => i >= before && u.includes('/digest/') && u.includes('/lunch/')).length, 0)
})

test('a digest outage keeps the last good digest, and with nothing cached the weeks to come are just empty', async () => {
  process.env.NUTRISLICE_CACHE_MS = String(60 * 60 * 1000)
  const good = stubFetch()
  const first = await getDiningUpcoming({ now: at('08:00'), fetchImpl: good.fetchImpl })
  const later = await getDiningUpcoming({ now: at('10:00'), fetchImpl: stubFetch({ digestDown: true }).fetchImpl })
  assert.deepEqual(later.days.map((d) => d.date), first.days.map((d) => d.date))

  __resetDiningCacheForTests()
  __resetDiningHeadlinersForTests()
  const cold = await getDiningUpcoming({ now: at('10:00'), fetchImpl: stubFetch({ digestDown: true }).fetchImpl })
  assert.equal(cold.ok, true)
  // Only this week's specials remain, Wednesday to Saturday.
  assert.deepEqual(cold.days.map((d) => d.date), ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'])
})

test('without a snapshot there is nothing to look ahead from', async () => {
  const down = async () => ({ ok: false, status: 503, json: async () => null })
  const up = await getDiningUpcoming({ now: at('12:00'), fetchImpl: down })
  assert.deepEqual(up, { ok: false, error: 'dining_upcoming_unavailable', today: '2026-10-14', days: [] })
})
