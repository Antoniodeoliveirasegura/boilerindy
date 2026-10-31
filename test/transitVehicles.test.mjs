import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vehiclesAsOf } from '../src/transitVehicles.mjs'

// Two rows of production's /api/transit/vehicles on 2026-10-30, as TransLoc
// answered them at 12:43:39Z: each Seconds is how long before that answer the
// bus last reported.
const FETCHED = Date.parse('2026-10-30T12:43:39Z')
const ROWS = [
  { GroundSpeed: 14.00098423911, Heading: 270, IsDelayed: false, IsOnRoute: true, Latitude: 39.77735, Longitude: -86.17665, Name: '9397', RouteID: 32, Seconds: 15, TimeStamp: '/Date(1793385834000-0600)/', VehicleID: 9 },
  { GroundSpeed: 25.99991049867, Heading: 95, IsDelayed: false, IsOnRoute: true, Latitude: 39.76941, Longitude: -86.17134, Name: '9399', RouteID: 33, Seconds: 9, TimeStamp: '/Date(1793385828000-0600)/', VehicleID: 5 },
]
const withoutSeconds = (rows) => rows.map(({ Seconds, ...rest }) => rest)

test('grows each Seconds by the whole seconds since the copy was fetched, and leaves the cached rows as they were', () => {
  const before = structuredClone(ROWS)
  // Within its first second the copy goes out as TransLoc sent it.
  assert.equal(vehiclesAsOf(ROWS, FETCHED, FETCHED + 900), ROWS)
  // Late in the 4 s cache.
  assert.deepEqual(vehiclesAsOf(ROWS, FETCHED, FETCHED + 3900).map((row) => row.Seconds), [18, 12])
  // TransLoc down, the cache serving its last good copy three minutes on.
  const sent = vehiclesAsOf(ROWS, FETCHED, FETCHED + 3 * 60 * 1000)
  assert.deepEqual(sent.map((row) => row.Seconds), [195, 189])
  assert.deepEqual(withoutSeconds(sent), withoutSeconds(before))
  assert.deepEqual(ROWS, before)
})

test('leaves alone a row without a numeric Seconds, an answer that is not a list, and a clock that went back', () => {
  const rows = [{ VehicleID: 1 }, { VehicleID: 2, Seconds: '15' }, null, { VehicleID: 3, Seconds: 9 }]
  assert.deepEqual(vehiclesAsOf(rows, FETCHED, FETCHED + 60 * 1000), [{ VehicleID: 1 }, { VehicleID: 2, Seconds: '15' }, null, { VehicleID: 3, Seconds: 69 }])
  const envelope = { from: 'GetMapVehiclePoints' }
  assert.equal(vehiclesAsOf(envelope, FETCHED, FETCHED + 60 * 1000), envelope)
  assert.equal(vehiclesAsOf(ROWS, FETCHED, FETCHED - 5000), ROWS)
  assert.equal(vehiclesAsOf(ROWS, undefined, FETCHED), ROWS)
})
