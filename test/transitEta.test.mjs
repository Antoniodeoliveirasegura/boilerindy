import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AVG_STOP_MINUTES, STOP_MATCH_METERS, findStopIndex, haversineMeters, positionArrivals, stopsAway } from '../src/transitEta.mjs'

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
