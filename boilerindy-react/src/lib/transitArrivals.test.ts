import { expect, test } from 'vitest'
import { placeForStop, translocEtaText, type TransitArrivals, type TransitPlace } from './transitArrivals'

// Issue #549: TransLoc's times on Home's bus rows. The places and the answer
// are as the server sent them on 2026-10-30 (docs/widget-reads.md).

const crimson = { routeId: 31, routeNum: '1', routeName: 'Crimson', color: '#990000' }
const gray = { routeId: 19, routeNum: '2', routeName: 'Gray', color: '#83786F' }
const orange = { routeId: 34, routeNum: '7', routeName: 'Orange', color: '#E68217' }
const PLACES: TransitPlace[] = [
  { key: 'riverwalk-apartments', name: 'Riverwalk Apartments', lat: 39.773819, lon: -86.185254, routes: [crimson, gray, orange] },
  { key: 'michigan-and-blackford', name: 'Michigan and Blackford', lat: 39.774493, lon: -86.170475, routes: [crimson, gray] },
]
const NOW = Date.parse('2026-10-30T10:40:26Z')
const RIVERWALK: TransitArrivals = {
  place: { key: 'riverwalk-apartments', name: 'Riverwalk Apartments', routes: [crimson, gray, orange] },
  fetchedAt: '2026-10-30T10:40:26Z',
  arrivals: [
    { ...orange, at: '2026-10-30T10:50:26Z', source: 'position', vehicleId: 41 },
    { ...gray, at: '2026-10-30T10:50:33Z', source: 'transloc', vehicleId: 12 },
    { ...crimson, at: '2026-10-30T10:51:43Z', source: 'transloc', vehicleId: 28 },
  ],
}

test('a stop belongs to the nearest place within 150 m', () => {
  // Gray's Michigan and Blackford stop, across the street from the others.
  expect(placeForStop(PLACES, 39.7742940502, -86.1701836822)?.key).toBe('michigan-and-blackford')
  expect(placeForStop(PLACES, 39.773819, -86.185254)?.key).toBe('riverwalk-apartments')
  // Long Hall, 500 m from either.
  expect(placeForStop(PLACES, 39.774708, -86.179089)).toBeNull()
  expect(placeForStop([], 39.773819, -86.185254)).toBeNull()
})

test("TransLoc's time for the row's own bus, in minutes to the student's stop", () => {
  expect(translocEtaText(RIVERWALK, 12, NOW)).toBe('10 min to your stop (Riverwalk Apartments)')
  // The feed's VehicleID may come as a string.
  expect(translocEtaText(RIVERWALK, '28', NOW)).toBe('11 min to your stop (Riverwalk Apartments)')
  // Inside a minute, or due a moment ago.
  expect(translocEtaText(RIVERWALK, 12, Date.parse('2026-10-30T10:49:40Z'))).toBe('Arriving at your stop (Riverwalk Apartments)')
  expect(translocEtaText(RIVERWALK, 12, Date.parse('2026-10-30T10:50:50Z'))).toBe('Arriving at your stop (Riverwalk Apartments)')
})

test('no TransLoc time leaves the row to the stop count', () => {
  // The Orange time is the server's own position estimate, not TransLoc's.
  expect(translocEtaText(RIVERWALK, 41, NOW)).toBeNull()
  // A bus the answer does not name, no bus, no answer, a broken time.
  expect(translocEtaText(RIVERWALK, 99, NOW)).toBeNull()
  expect(translocEtaText(RIVERWALK, undefined, NOW)).toBeNull()
  expect(translocEtaText(undefined, 12, NOW)).toBeNull()
  expect(translocEtaText({ ...RIVERWALK, arrivals: [{ ...gray, at: 'soon', source: 'transloc', vehicleId: 12 }] }, 12, NOW)).toBeNull()
})
