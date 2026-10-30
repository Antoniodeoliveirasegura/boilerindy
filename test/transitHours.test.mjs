import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROUTE_HOURS, routeHours } from '../src/transitHours.mjs'

// The route hours the website and the widget reads share (src/transitHours.mjs).
// Each label is typed by hand beside the numbers it describes, so a new
// semester's hours could change one and not the other: these check they agree,
// and that every entry reads the way the clients count on.

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const minutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// "06:30" -> "6:30a", "22:00" -> "10:00p", "00:00" -> "12:00a", as the website writes them.
const clock = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`
}

// Runs of days in week order from Monday: [1, 2, 3, 4, 5] is "Mon-Fri" and [0, 6] "Sat-Sun".
const dayRuns = (days) => {
  const runs = []
  for (const day of [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d))) {
    const run = runs.at(-1)
    if (run && (run.at(-1) + 1) % 7 === day) run.push(day)
    else runs.push([day])
  }
  return runs.map((run) => (run.length === 1 ? DAY[run[0]] : `${DAY[run[0]]}-${DAY[run.at(-1)]}`)).join(', ')
}

test('every route runs on some days, from a start to a later end the same day, and its label says so', () => {
  assert.deepEqual(Object.keys(ROUTE_HOURS), ['1', '2', '3', '4', '5', '7'])
  for (const [num, hours] of Object.entries(ROUTE_HOURS)) {
    assert.ok(hours.days.length > 0, num)
    assert.ok(hours.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6), num)
    assert.deepEqual(hours.days, [...new Set(hours.days)].sort((a, b) => a - b), `${num}: each day once, in order`)
    assert.match(hours.start, HHMM_RE, num)
    assert.match(hours.end, HHMM_RE, num)
    // "00:00" is the midnight that ends the day; no route runs into the next one.
    const end = hours.end === '00:00' ? 24 * 60 : minutes(hours.end)
    assert.ok(minutes(hours.start) < end, num)
    assert.equal(hours.label, `${dayRuns(hours.days)} ${clock(hours.start)}-${clock(hours.end)}`, num)
  }
  assert.deepEqual(ROUTE_HOURS[5], { days: [1, 2, 3, 4, 5], start: '07:00', end: '22:00', label: 'Mon-Fri 7:00a-10:00p' })
  assert.equal(ROUTE_HOURS[7].label, 'Sat-Sun 9:00a-8:00p')
})

test('routeHours finds a route by its printed number, and null for one with no hours on file', () => {
  assert.equal(routeHours('5'), ROUTE_HOURS[5])
  assert.equal(routeHours(5), ROUTE_HOURS[5])
  // Green (6) is in the routes feed but not running; a charter has no number.
  for (const none of ['6', '', null, undefined, 'constructor', '__proto__']) {
    assert.equal(routeHours(none), null, String(none))
  }
})
