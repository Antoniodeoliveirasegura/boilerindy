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
// transloc-stop-arrival-times.json is the JagLine relay's unfiltered
// GetStopArrivalTimes answer of 2026-10-30, whose Date header read NOW below,
// trimmed to the rows at Riverwalk Apartments, Michigan and Blackford and
// BRTC, with its en dashes made hyphens (the sample is on #549). Gray,
// Crimson, Yellow and Blue were running; Purple and Orange had not started.

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const ARRIVALS = load('transloc-stop-arrival-times.json')
const INDEX = buildTransitIndex(load('transloc-stops.json'), load('transloc-routes.json'))
const NOW = Date.parse('2026-10-30T10:40:26Z')
const SEC = 1000
const MIN = 60 * SEC
const RIVERWALK = INDEX.byKey.get('riverwalk-apartments')
const BLACKFORD = INDEX.byKey.get('michigan-and-blackford')
const routes = {
  crimson: { routeId: 31, routeNum: '1', routeName: 'Crimson', color: '#990000' },
  gray: { routeId: 19, routeNum: '2', routeName: 'Gray', color: '#83786F' },
  yellow: { routeId: 32, routeNum: '3', routeName: 'Yellow', color: '#F1BE48' },
  orange: { routeId: 34, routeNum: '7', routeName: 'Orange', color: '#E68217' },
}

test('parseRelayDate reads the relay\'s /Date(ms)/ times, with or without an offset', () => {
  assert.equal(parseRelayDate('/Date(1793357433995)/'), 1793357433995)
  assert.equal(parseRelayDate('/Date(1793375242000-0600)/'), 1793375242000)
  assert.equal(parseRelayDate('/Date(1793375242000+0900)/'), 1793375242000)
  assert.equal(parseRelayDate('/Date(-1000)/'), -1000)
  for (const junk of ['2026-10-30T10:40:26Z', 1793357433995, Number.NaN, '', 'soon', null, undefined, {}, '/Date(soon)/']) {
    assert.equal(parseRelayDate(junk), null, String(junk))
  }
})

test('the sample: Seconds counts down from the moment the relay answered, which EstimateTime and Time agree with', () => {
  const times = ARRIVALS.flatMap((row) => row.Times)
  assert.equal(times.length, 8)
  const answeredAt = new Set(times.map((time) => parseRelayDate(time.EstimateTime) - time.Seconds * SEC))
  assert.equal(answeredAt.size, 1)
  const [at] = answeredAt
  assert.ok(at >= NOW && at < NOW + SEC, `answered within the Date header's second, at ${new Date(at).toISOString()}`)
  assert.ok(times.every((time) => time.Time === time.EstimateTime && time.VehicleId > 0 && time.IsDeparted === false && time.ScheduledTime === null))
})

test('the parser keeps the buses\' times at the wanted stops, soonest first', () => {
  assert.deepEqual(parseStopArrivalTimes(ARRIVALS, { now: NOW, routeStopIds: [243, 369, 409] }), [
    { routeId: 19, routeStopId: 243, at: NOW + 607 * SEC, vehicleId: 12, arriving: false },
    { routeId: 31, routeStopId: 369, at: NOW + 677 * SEC, vehicleId: 28, arriving: false },
  ])
})

test('without a stop filter every row counts, an arriving bus included', () => {
  const parsed = parseStopArrivalTimes(ARRIVALS, { now: NOW })
  assert.deepEqual(
    parsed.map((e) => [e.routeId, e.routeStopId, (e.at - NOW) / SEC, e.arriving]),
    [
      [27, 322, 1, true],
      [19, 214, 91, false],
      [31, 365, 371, false],
      [32, 375, 455, false],
      [27, 322, 463, false],
      [19, 243, 607, false],
      [31, 369, 677, false],
      [32, 375, 946, false],
    ],
  )
})

test('Seconds first, else EstimateTime; departed, schedule-only and far-off times are left out', () => {
  // Gray's time at Riverwalk Apartments from the sample, changed one way at a time.
  const real = ARRIVALS[0].Times[0]
  const row = (...times) => [{ RouteId: 19, RouteStopId: 243, Times: times }]
  const read = (...times) => parseStopArrivalTimes(row(...times), { now: NOW }).map((e) => (e.at - NOW) / SEC)
  assert.deepEqual(read(real), [607])
  // Without Seconds, EstimateTime stands in: the relay answered 0.995 s into NOW's second.
  assert.deepEqual(read({ ...real, Seconds: null }), [607.995])
  assert.deepEqual(read({ ...real, IsDeparted: true }), [])
  // A schedule with no tracked bus behind it (none came back on 2026-10-30).
  assert.deepEqual(read({ ...real, EstimateTime: null, VehicleId: null, ScheduledTime: real.Time }), [])
  // Two and a half hours out is past the horizon.
  assert.deepEqual(read({ ...real, Seconds: 9000 }), [])
  // A bus due a moment ago may still be at the stop; one due minutes ago has gone.
  assert.equal(ESTIMATE_GRACE_MS, 60 * SEC)
  assert.deepEqual(read({ ...real, Seconds: -30 }, { ...real, Seconds: -120 }), [-30])
})

test('the parser never throws and reads an unknown shape as no estimates', () => {
  const stopsFeedSpelling = [{ RouteID: 31, RouteStopID: 369, Times: ARRIVALS[4].Times }]
  for (const junk of [null, undefined, '', 'nope', 42, {}, { d: ARRIVALS }, [null, 1, 'x'], stopsFeedSpelling, [{ RouteId: 31, RouteStopId: 369 }], [{ RouteId: 31, Times: [] }]]) {
    assert.deepEqual(parseStopArrivalTimes(junk, { now: NOW }), [], JSON.stringify(junk)?.slice(0, 80))
  }
})

test('unreadTimes flags an answer with times the parser could not read', () => {
  assert.equal(unreadTimes(ARRIVALS, parseStopArrivalTimes(ARRIVALS, { now: NOW })), false)
  const unknown = [{ RouteId: 31, RouteStopId: 369, Times: [{ Minutes: 4 }] }]
  assert.equal(unreadTimes(unknown, parseStopArrivalTimes(unknown, { now: NOW })), true)
  // The relay's answer when no bus is running.
  assert.equal(unreadTimes([], []), false)
  assert.equal(unreadTimes('', []), false)
})

// An Orange bus at Michigan and Blackford reporting an old RouteID (29, a
// hidden Orange variant): five Orange stops from Riverwalk Apartments.
const ORANGE_AT_BLACKFORD = { VehicleID: 41, RouteID: 29, Latitude: 39.774493, Longitude: -86.170475, IsOnRoute: true }
// A Crimson bus, which must not add to Crimson's TransLoc estimates.
const CRIMSON_AT_LONG_HALL = { VehicleID: 27, RouteID: 31, Latitude: 39.774708, Longitude: -86.179089, IsOnRoute: true }

test('Riverwalk Apartments: TransLoc for Gray and Crimson, the position estimate for Orange, soonest first', () => {
  const estimates = parseStopArrivalTimes(ARRIVALS, { now: NOW, routeStopIds: RIVERWALK.stops.map((s) => s.routeStopId) })
  const answer = buildArrivals({ place: RIVERWALK, index: INDEX, estimates, vehicles: [ORANGE_AT_BLACKFORD, CRIMSON_AT_LONG_HALL], now: NOW })
  const { crimson, gray, orange } = routes
  assert.deepEqual(answer, {
    place: { key: 'riverwalk-apartments', name: 'Riverwalk Apartments', routes: [crimson, gray, orange] },
    fetchedAt: '2026-10-30T10:40:26Z',
    arrivals: [
      { ...orange, at: '2026-10-30T10:50:26Z', source: 'position' },
      { ...gray, at: '2026-10-30T10:50:33Z', source: 'transloc' },
      { ...crimson, at: '2026-10-30T10:51:43Z', source: 'transloc' },
    ],
  })
})

test('Michigan and Blackford at the sample\'s moment: TransLoc for the three routes running, none for the two that were not', () => {
  // The buses the vehicles feed reported in the same minute.
  const vehicles = [
    { VehicleID: 1, RouteID: 27, Latitude: 39.788424, Longitude: -86.185953, GroundSpeed: 0, Heading: 0, IsOnRoute: true },
    { VehicleID: 11, RouteID: 27, Latitude: 39.774708, Longitude: -86.179089, GroundSpeed: 7.99928417304, Heading: 277, IsOnRoute: true },
    { VehicleID: 26, RouteID: 32, Latitude: 39.78853, Longitude: -86.18613, GroundSpeed: 0, Heading: 0, IsOnRoute: true },
    { VehicleID: 9, RouteID: 32, Latitude: 39.7773, Longitude: -86.17584, GroundSpeed: 9.9991052163, Heading: 270, IsOnRoute: true },
    { VehicleID: 28, RouteID: 31, Latitude: 39.77199, Longitude: -86.18365, GroundSpeed: 0.99991052163, Heading: 181, IsOnRoute: true },
    { VehicleID: 12, RouteID: 19, Latitude: 39.77443, Longitude: -86.17625, GroundSpeed: 23.00017893378, Heading: 93, IsOnRoute: true },
  ]
  const estimates = parseStopArrivalTimes(ARRIVALS, { now: NOW, routeStopIds: BLACKFORD.stops.map((s) => s.routeStopId) })
  const { arrivals } = buildArrivals({ place: BLACKFORD, index: INDEX, estimates, vehicles, now: NOW })
  const { crimson, gray, yellow } = routes
  assert.deepEqual(arrivals, [
    { ...gray, at: '2026-10-30T10:41:57Z', source: 'transloc' },
    { ...crimson, at: '2026-10-30T10:46:37Z', source: 'transloc' },
    { ...yellow, at: '2026-10-30T10:48:01Z', source: 'transloc' },
    { ...yellow, at: '2026-10-30T10:56:12Z', source: 'transloc' },
  ])
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
