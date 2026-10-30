import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  AVG_STOP_MINUTES,
  PAIRED_STOP_METERS,
  STOP_MATCH_METERS,
  bearingDegrees,
  findStopIndex,
  haversineMeters,
  positionArrivals,
  stopsAway,
} from '../src/transitEta.mjs'
import { buildTransitIndex } from '../src/transitPlaces.mjs'

// Issue #549: the position-based fallback for a route TransLoc gives no
// estimate for, ported from the website's describeBusEta: the stops between
// the bus and the stop on a loop route, times two minutes.

// A loop of five stops about 1.1 km apart going north, so each one is well
// outside the next one's 300 m.
const LOOP = [0, 1, 2, 3, 4].map((i) => ({ lat: 39.77 + i * 0.01, lon: -86.17 }))
const NOW = Date.parse('2026-10-28T12:42:00Z')
const MIN = 60 * 1000

test('haversineMeters measures short campus distances', () => {
  assert.equal(haversineMeters(39.77, -86.17, 39.77, -86.17), 0)
  const d = haversineMeters(39.77, -86.17, 39.78, -86.17)
  assert.ok(d > 1100 && d < 1115, `${d}`)
})

test('findStopIndex takes the nearest stop within 300 m, else -1', () => {
  assert.equal(STOP_MATCH_METERS, 300)
  assert.equal(findStopIndex(LOOP, 39.79, -86.17), 2)
  // About 200 m north of stop 2: still at it.
  assert.equal(findStopIndex(LOOP, 39.7918, -86.17), 2)
  // About 550 m north of stop 2, halfway to stop 3: between stops.
  assert.equal(findStopIndex(LOOP, 39.795, -86.17), -1)
  assert.equal(findStopIndex([], 39.79, -86.17), -1)
})

test('stopsAway counts forward in route order and wraps around the loop', () => {
  assert.equal(stopsAway(LOOP, 39.78, -86.17, [3]), 2)
  // Stop 0 is behind a bus at stop 3: the rest of the loop.
  assert.equal(stopsAway(LOOP, 39.80, -86.17, [0]), 2)
  assert.equal(stopsAway(LOOP, 39.80, -86.17, [2]), 4)
  // A bus at the stop arrives now.
  assert.equal(stopsAway(LOOP, 39.79, -86.17, [2]), 0)
  // A place the route serves twice: the nearer of the two ahead.
  assert.equal(stopsAway(LOOP, 39.78, -86.17, [0, 4]), 3)
  assert.equal(stopsAway(LOOP, 39.795, -86.17, [3]), null, 'between stops')
  assert.equal(stopsAway(LOOP, 39.78, -86.17, []), null, 'no target')
  assert.equal(stopsAway(LOOP, Number.NaN, -86.17, [3]), null, 'no position')
  assert.equal(stopsAway([], 39.78, -86.17, [0]), null, 'no stops')
})

test('positionArrivals: one per bus near a stop, AVG_STOP_MINUTES a stop, soonest first', () => {
  assert.equal(AVG_STOP_MINUTES, 2)
  const vehicles = [
    { VehicleID: 1, Latitude: 39.77, Longitude: -86.17, IsOnRoute: true }, // stop 0: 3 stops from stop 3
    { VehicleID: 2, Latitude: 39.79, Longitude: -86.17 }, // stop 2: 1 stop
    { VehicleID: 3, Latitude: 39.795, Longitude: -86.17 }, // between stops: no estimate
    { VehicleID: 4, Latitude: 39.78, Longitude: -86.17, IsOnRoute: false }, // off its route
    { VehicleID: 5, Latitude: 39.80, Longitude: -86.17 }, // at stop 3: now
  ]
  assert.deepEqual(positionArrivals({ routeStops: LOOP, targetIndexes: [3], vehicles, now: NOW }), [
    { at: NOW, stopsAway: 0, vehicleId: 5 },
    { at: NOW + 2 * MIN, stopsAway: 1, vehicleId: 2 },
    { at: NOW + 6 * MIN, stopsAway: 3, vehicleId: 1 },
  ])
  assert.deepEqual(positionArrivals({ routeStops: LOOP, targetIndexes: [3], vehicles: [], now: NOW }), [])
})

test('bearingDegrees is the compass bearing, clockwise from north', () => {
  const at = { lat: 39.77, lon: -86.17 }
  assert.ok(Math.abs(bearingDegrees(at, { lat: 39.78, lon: -86.17 }) - 0) < 0.001)
  assert.ok(Math.abs(bearingDegrees(at, { lat: 39.77, lon: -86.16 }) - 90) < 0.01)
  assert.ok(Math.abs(bearingDegrees(at, { lat: 39.76, lon: -86.17 }) - 180) < 0.001)
  assert.ok(Math.abs(bearingDegrees(at, { lat: 39.77, lon: -86.18 }) - 270) < 0.01)
})

// Yellow passes 404 Lot twice: its inbound and outbound stops are 13 m apart.
// The bus is the one the feed reported there at 09:47 UTC on 2026-10-30,
// arriving at 404 Lot-Inbound by TransLoc (297 s to Michigan and Blackford),
// 0 m from the outbound stop and 13 m from the inbound one.
const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const INDEX = buildTransitIndex(load('transloc-stops.json'), load('transloc-routes.json'))
const YELLOW = INDEX.routeStops.get(32)
const at = (key) => YELLOW.findIndex((stop) => stop.placeKey === key)
const BUS_AT_404_LOT = { lat: 39.784008, lon: -86.179256 }

test("a moving bus's heading picks the pass where a route serves one spot twice", () => {
  assert.equal(PAIRED_STOP_METERS, 60)
  const inbound = at('404-lot-inbound')
  const outbound = at('404-lot-outbound')
  // Without a heading, the nearest stop: the outbound one.
  assert.equal(findStopIndex(YELLOW, BUS_AT_404_LOT.lat, BUS_AT_404_LOT.lon), outbound)
  // Heading southeast, as the bus was: the inbound pass.
  assert.equal(findStopIndex(YELLOW, BUS_AT_404_LOT.lat, BUS_AT_404_LOT.lon, 139), inbound)
  // Heading along the outbound pass's way out: the outbound stop.
  const outboundWay = bearingDegrees(YELLOW[outbound], YELLOW[(outbound + 1) % YELLOW.length])
  assert.equal(findStopIndex(YELLOW, BUS_AT_404_LOT.lat, BUS_AT_404_LOT.lon, outboundWay), outbound)
  // A spot the route serves once keeps its stop whatever the heading.
  const blackford = YELLOW[at('michigan-and-blackford')]
  assert.equal(findStopIndex(YELLOW, blackford.lat, blackford.lon, 0), at('michigan-and-blackford'))
  assert.equal(findStopIndex(YELLOW, blackford.lat, blackford.lon, 180), at('michigan-and-blackford'))
})

test('positionArrivals: the moving bus at 404 Lot is 3 stops from Michigan and Blackford; stopped, the old 9', () => {
  const targetIndexes = [at('michigan-and-blackford')]
  const moving = { VehicleID: 26, Latitude: BUS_AT_404_LOT.lat, Longitude: BUS_AT_404_LOT.lon, GroundSpeed: 10.99901573793, Heading: 139 }
  assert.deepEqual(positionArrivals({ routeStops: YELLOW, targetIndexes, vehicles: [moving], now: NOW }), [
    { at: NOW + 6 * MIN, stopsAway: 3, vehicleId: 26 },
  ])
  // A stopped bus reports heading 0, which says nothing: the nearest stop again,
  // whatever heading a stopped row carries.
  for (const Heading of [0, 139]) {
    const stopped = { ...moving, GroundSpeed: 0, Heading }
    assert.deepEqual(positionArrivals({ routeStops: YELLOW, targetIndexes, vehicles: [stopped], now: NOW }), [
      { at: NOW + 18 * MIN, stopsAway: 9, vehicleId: 26 },
    ])
  }
})
