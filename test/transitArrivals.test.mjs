import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ESTIMATE_GRACE_MS,
  MAX_ARRIVALS,
  MAX_PER_ROUTE,
  buildArrivals,
  parseRelayDate,
  parseStopArrivalTimes,
  unreadTimes,
} from '../src/transitArrivals.mjs'
import { buildTransitIndex } from '../src/transitPlaces.mjs'

// Issue #549: the arrivals answer. TransLoc's own estimates come first; a
// route with none gets the position-based estimate.
//
// transloc-stop-arrival-times.UNVERIFIED.json is MADE UP: no GetStopArrivalTimes
// answer from this agency's relay has been seen yet (it needs the server's
// TRANSLOC_API_KEY). It follows the RideSystems shape public clients of other
// agencies read, both spellings of the id fields included, and is built
// around NOW below. Replace it with the trimmed real sample from #549, then
// fix the parser until these tests describe the real thing.

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const ARRIVALS = load('transloc-stop-arrival-times.UNVERIFIED.json')
const INDEX = buildTransitIndex(load('transloc-stops.json'), load('transloc-routes.json'))
const NOW = Date.parse('2026-10-28T12:42:00Z')
const SEC = 1000
const MIN = 60 * SEC
const RIVERWALK = INDEX.byKey.get('riverwalk-apartments')
const BLACKFORD = INDEX.byKey.get('michigan-and-blackford')

test('parseRelayDate reads the relay\'s WCF dates, ISO strings and ms', () => {
  assert.equal(parseRelayDate('/Date(1793191560000-0400)/'), 1793191560000)
  assert.equal(parseRelayDate('/Date(1793191560000+0900)/'), 1793191560000)
  assert.equal(parseRelayDate('/Date(1793191560000)/'), 1793191560000)
  assert.equal(parseRelayDate('/Date(-1000)/'), -1000)
  assert.equal(parseRelayDate('2026-10-28T12:46:00Z'), Date.parse('2026-10-28T12:46:00Z'))
  assert.equal(parseRelayDate(1793191560000), 1793191560000)
  for (const junk of [Number.NaN, '', 'soon', null, undefined, {}, '/Date(soon)/']) {
    assert.equal(parseRelayDate(junk), null, String(junk))
  }
})

test('the parser keeps tracked buses\' times at the wanted stops, soonest first', () => {
  assert.deepEqual(parseStopArrivalTimes(ARRIVALS, { now: NOW, routeStopIds: [243, 369, 409] }), [
    { routeId: 31, routeStopId: 369, at: NOW + 240 * SEC, vehicleId: 27, arriving: false },
    // Spelled RouteId and RouteStopId in the fixture. Its schedule-only time
    // (no EstimateTime, no VehicleId) and its departed bus are left out.
    { routeId: 19, routeStopId: 243, at: NOW + 780 * SEC, vehicleId: 17, arriving: false },
    { routeId: 31, routeStopId: 369, at: NOW + 1140 * SEC, vehicleId: 12, arriving: false },
  ])
})

test('without a stop filter every row counts; an EstimateTime stands in for Seconds; far-off times are noise', () => {
  const parsed = parseStopArrivalTimes(ARRIVALS, { now: NOW })
  assert.deepEqual(
    parsed.map((e) => [e.routeId, e.routeStopId, (e.at - NOW) / SEC]),
    [
      [31, 369, 240],
      [32, 375, 300],
      [33, 397, 360],
      [19, 243, 780],
      [31, 369, 1140],
    ],
  )
  // Purple's other time is 2.5 h out, past the two-hour horizon.
  assert.ok(!parsed.some((e) => e.at - NOW > 2 * 60 * MIN))
})

test('the parser never throws and reads an unknown shape as no estimates', () => {
  for (const junk of [null, undefined, '', 'nope', 42, {}, { d: 'x' }, [null, 1, 'x'], [{ RouteID: 31, RouteStopID: 369 }], [{ RouteID: 31, Times: [] }]]) {
    assert.deepEqual(parseStopArrivalTimes(junk, { now: NOW }), [], JSON.stringify(junk))
  }
  // A WCF "d" wrapper is unwrapped.
  assert.equal(parseStopArrivalTimes({ d: ARRIVALS }, { now: NOW, routeStopIds: [369] }).length, 2)
  // A bus due a moment ago may still be at the stop; one due minutes ago has gone.
  const due = (seconds) => [{ RouteID: 31, RouteStopID: 369, Times: [{ Seconds: seconds, VehicleId: 27 }] }]
  assert.equal(ESTIMATE_GRACE_MS, 60 * SEC)
  assert.equal(parseStopArrivalTimes(due(-30), { now: NOW }).length, 1)
  assert.equal(parseStopArrivalTimes(due(-120), { now: NOW }).length, 0)
})

test('unreadTimes flags an answer with times the parser could not read', () => {
  assert.equal(unreadTimes(ARRIVALS, parseStopArrivalTimes(ARRIVALS, { now: NOW })), false)
  const unknown = [{ RouteID: 31, RouteStopID: 369, Times: [{ Minutes: 4 }] }]
  assert.equal(unreadTimes(unknown, parseStopArrivalTimes(unknown, { now: NOW })), true)
  const quiet = [{ RouteID: 34, RouteStopID: 409, Times: [] }]
  assert.equal(unreadTimes(quiet, parseStopArrivalTimes(quiet, { now: NOW })), false)
  assert.equal(unreadTimes('', []), false)
})

// An Orange bus at Michigan and Blackford reporting an old RouteID (29, a
// hidden Orange variant): five Orange stops from Riverwalk Apartments.
const ORANGE_AT_BLACKFORD = { VehicleID: 41, RouteID: 29, Latitude: 39.774493, Longitude: -86.170475, IsOnRoute: true }
// A Crimson bus, which must not add to Crimson's TransLoc estimates.
const CRIMSON_AT_LONG_HALL = { VehicleID: 27, RouteID: 31, Latitude: 39.774708, Longitude: -86.179089, IsOnRoute: true }

test('Riverwalk Apartments: TransLoc for Crimson and Gray, the position estimate for Orange, soonest first', () => {
  const estimates = parseStopArrivalTimes(ARRIVALS, { now: NOW, routeStopIds: RIVERWALK.stops.map((s) => s.routeStopId) })
  const answer = buildArrivals({ place: RIVERWALK, index: INDEX, estimates, vehicles: [ORANGE_AT_BLACKFORD, CRIMSON_AT_LONG_HALL], now: NOW })
  const crimson = { routeId: 31, routeNum: '1', routeName: 'Crimson', color: '#990000' }
  const gray = { routeId: 19, routeNum: '2', routeName: 'Gray', color: '#83786F' }
  const orange = { routeId: 34, routeNum: '7', routeName: 'Orange', color: '#E68217' }
  assert.deepEqual(answer, {
    place: { key: 'riverwalk-apartments', name: 'Riverwalk Apartments', routes: [crimson, gray, orange] },
    fetchedAt: '2026-10-28T12:42:00Z',
    arrivals: [
      { ...crimson, at: '2026-10-28T12:46:00Z', source: 'transloc' },
      { ...orange, at: '2026-10-28T12:52:00Z', source: 'position' },
      { ...gray, at: '2026-10-28T12:55:00Z', source: 'transloc' },
      { ...crimson, at: '2026-10-28T13:01:00Z', source: 'transloc' },
    ],
  })
})

test('when the parser finds nothing, every route falls back to the bus positions', () => {
  const answer = buildArrivals({ place: RIVERWALK, index: INDEX, estimates: [], vehicles: [ORANGE_AT_BLACKFORD, CRIMSON_AT_LONG_HALL], now: NOW })
  // Crimson: Long Hall is three stops before Riverwalk Apartments.
  assert.deepEqual(
    answer.arrivals.map((a) => [a.routeName, (Date.parse(a.at) - NOW) / MIN, a.source]),
    [
      ['Crimson', 6, 'position'],
      ['Orange', 10, 'position'],
    ],
  )
})

test('a place with no bus coming answers an empty list', () => {
  const answer = buildArrivals({ place: RIVERWALK, index: INDEX, estimates: [], vehicles: [], now: NOW })
  assert.deepEqual(answer.arrivals, [])
  assert.equal(answer.place.key, 'riverwalk-apartments')
})

test('estimates count only at the place\'s own stops, under the route a variant RouteID stands for', () => {
  const estimates = [
    // Crimson at Michigan and Blackford, not Riverwalk Apartments.
    { routeId: 31, routeStopId: 365, at: NOW + 2 * MIN, vehicleId: 27, arriving: false },
    // An old Crimson RouteID at Riverwalk Apartments' Crimson stop.
    { routeId: 18, routeStopId: 369, at: NOW + 7 * MIN, vehicleId: 12, arriving: false },
    // A route the table does not know.
    { routeId: 999, routeStopId: 369, at: NOW + MIN, vehicleId: 3, arriving: false },
  ]
  const answer = buildArrivals({ place: RIVERWALK, index: INDEX, estimates, vehicles: [], now: NOW })
  assert.deepEqual(answer.arrivals.map((a) => [a.routeName, (Date.parse(a.at) - NOW) / MIN, a.source]), [['Crimson', 7, 'transloc']])
})

test('at most two per route and eight in all', () => {
  assert.equal(MAX_PER_ROUTE, 2)
  assert.equal(MAX_ARRIVALS, 8)
  // Three buses on each of Michigan and Blackford's five routes, a route's
  // all due before the next route's.
  const estimates = BLACKFORD.stops.flatMap(({ routeId, routeStopId }, r) =>
    [1, 2, 3].map((n) => ({ routeId, routeStopId, at: NOW + (r * 10 + n) * MIN, vehicleId: r * 10 + n, arriving: false })),
  )
  const { arrivals } = buildArrivals({ place: BLACKFORD, index: INDEX, estimates, vehicles: [], now: NOW })
  // Each route's third bus is left out, and Orange, ninth, is past the eight.
  assert.deepEqual(
    arrivals.map((a) => [a.routeName, (Date.parse(a.at) - NOW) / MIN]),
    [
      ['Gray', 1],
      ['Gray', 2],
      ['Crimson', 11],
      ['Crimson', 12],
      ['Yellow', 21],
      ['Yellow', 22],
      ['Purple', 31],
      ['Purple', 32],
    ],
  )
})
