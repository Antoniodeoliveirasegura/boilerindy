import { describe, expect, test } from 'vitest'
import {
  TRANLOC_ROUTE_ALIASES,
  buildTranslocRouteIdMap,
  canonicalFromMap,
  getOrderedStopsForRoute,
  haversineMeters,
  inferCanonicalFromTransLocRoute,
  isRouteActiveNow,
  nearestStopForVehicle,
  routes,
  type TransitRoute,
} from './transitShared'

// Issue #225 - isRouteActiveNow reads the clock in America/Indiana/Indianapolis
// and had no test, so the midnight-ending routes and the weekend-only route
// were never pinned. Every instant below is a UTC string, so the expectations
// hold whatever timezone the test runner has: 16:00Z is 12:00 EDT in September
// and 17:00Z is 12:00 EST in January.

const byNum = (num: string) => routes.find((r) => r.num === num)!
const crimson = byNum('1') // Mon-Fri 06:30-22:00
const yellow = byNum('3') // Mon-Fri 05:30-00:00, runs until midnight
const orange = byNum('7') // Sat-Sun 09:00-20:00

describe('isRouteActiveNow', () => {
  test('a weekday route runs on a Wednesday at noon and not on a Saturday', () => {
    expect(isRouteActiveNow(crimson, new Date('2026-09-09T16:00:00Z'))).toBe(true) // Wed 12:00 EDT
    expect(isRouteActiveNow(crimson, new Date('2026-09-12T16:00:00Z'))).toBe(false) // Sat 12:00 EDT
  })

  test('the weekend route is the other way round', () => {
    expect(isRouteActiveNow(orange, new Date('2026-09-12T16:00:00Z'))).toBe(true) // Sat 12:00 EDT
    expect(isRouteActiveNow(orange, new Date('2026-09-09T16:00:00Z'))).toBe(false) // Wed 12:00 EDT
  })

  test('the start is inclusive and the end is exclusive', () => {
    expect(isRouteActiveNow(crimson, new Date('2026-09-09T09:00:00Z'))).toBe(false) // Wed 05:00 EDT
    expect(isRouteActiveNow(crimson, new Date('2026-09-09T10:30:00Z'))).toBe(true) // Wed 06:30 EDT
    expect(isRouteActiveNow(crimson, new Date('2026-09-10T01:59:00Z'))).toBe(true) // Wed 21:59 EDT
    expect(isRouteActiveNow(crimson, new Date('2026-09-10T02:00:00Z'))).toBe(false) // Wed 22:00 EDT
  })

  test('a route that ends at 00:00 runs until midnight and not a minute past it', () => {
    expect(isRouteActiveNow(yellow, new Date('2026-09-10T03:30:00Z'))).toBe(true) // Wed 23:30 EDT
    expect(isRouteActiveNow(yellow, new Date('2026-09-10T04:10:00Z'))).toBe(false) // Thu 00:10 EDT
    expect(isRouteActiveNow(yellow, new Date('2026-09-10T09:30:00Z'))).toBe(true) // Thu 05:30 EDT
  })

  test('the Eastern clock follows standard time in January', () => {
    expect(isRouteActiveNow(crimson, new Date('2026-01-14T17:00:00Z'))).toBe(true) // Wed 12:00 EST
    expect(isRouteActiveNow(crimson, new Date('2026-01-14T11:00:00Z'))).toBe(false) // Wed 06:00 EST
    expect(isRouteActiveNow(crimson, new Date('2026-01-15T03:30:00Z'))).toBe(false) // Wed 22:30 EST
  })

  test('the weekday is Eastern too, not UTC', () => {
    // Friday 23:00 EDT is already Saturday 03:00 UTC: still a weekday for the route.
    expect(isRouteActiveNow(yellow, new Date('2026-09-12T03:00:00Z'))).toBe(true)
    // Sunday 21:00 EDT is Monday 01:00 UTC: still the weekend, and Orange is off after 20:00.
    expect(isRouteActiveNow(orange, new Date('2026-09-14T01:00:00Z'))).toBe(false)
    expect(isRouteActiveNow(orange, new Date('2026-09-13T23:00:00Z'))).toBe(true) // Sun 19:00 EDT
  })

  test('a route without a schedule is always active, and so is no route at all', () => {
    const green: TransitRoute = { id: 6, num: '6', name: 'Green', shortName: 'Green', color: '#0f0' }
    expect(isRouteActiveNow(green)).toBe(true)
    expect(isRouteActiveNow(null)).toBe(true)
    expect(isRouteActiveNow(undefined)).toBe(true)
  })

  test('defaults to the current instant', () => {
    expect(typeof isRouteActiveNow(crimson)).toBe('boolean')
  })
})

describe('TransLoc route mapping', () => {
  test('canonicalFromMap follows the map and passes unknown numeric ids through', () => {
    expect(canonicalFromMap(TRANLOC_ROUTE_ALIASES, 18)).toBe(31)
    expect(canonicalFromMap(TRANLOC_ROUTE_ALIASES, '22')).toBe(32)
    expect(canonicalFromMap(TRANLOC_ROUTE_ALIASES, 999)).toBe(999)
    expect(canonicalFromMap(TRANLOC_ROUTE_ALIASES, 'abc')).toBeNull()
  })

  test('inferCanonicalFromTransLocRoute reads the route number, then a colour word, then the hex colour', () => {
    expect(inferCanonicalFromTransLocRoute({ Description: 'Route 4 - Blue Line' })).toBe(27)
    expect(inferCanonicalFromTransLocRoute({ Description: 'Route 9 - Unknown' })).toBeNull()
    expect(inferCanonicalFromTransLocRoute({ Description: 'Purple Loop' })).toBe(33)
    expect(inferCanonicalFromTransLocRoute({ Description: 'Grey Shuttle' })).toBe(19)
    expect(inferCanonicalFromTransLocRoute({ Description: 'Campus shuttle', MapLineColor: 'F1BE48' })).toBe(32)
    expect(inferCanonicalFromTransLocRoute({ Description: 'Charter Bus' })).toBeNull()
    expect(inferCanonicalFromTransLocRoute({})).toBeNull()
  })

  test('buildTranslocRouteIdMap merges inferred ids with the static aliases, aliases winning', () => {
    const map = buildTranslocRouteIdMap([
      { RouteID: 40, Description: 'Route 1 - Crimson' },
      { RouteID: 18, Description: 'Route 5 - Purple' }, // alias says 31
      { RouteID: 'x', Description: 'Route 2' },
      { RouteID: 41, Description: 'Charter' },
    ])
    expect(map[40]).toBe(31)
    expect(map[18]).toBe(31)
    expect(map[41]).toBeUndefined()
    expect(buildTranslocRouteIdMap(null)).toEqual(TRANLOC_ROUTE_ALIASES)
  })
})

describe('stops and distances', () => {
  const stops = [
    { RouteID: 18, RouteStopID: 1, Latitude: 39.7742, Longitude: -86.1761, Description: 'Campus Center' },
    { RouteID: 31, RouteStopID: 1, Latitude: 39.7742, Longitude: -86.1761, Description: 'Campus Center (dup)' },
    { RouteID: 31, RouteStopID: null, Latitude: 39.7768, Longitude: -86.1739, Description: 'Library' },
    { RouteID: 19, RouteStopID: 2, Latitude: 39.78, Longitude: -86.17, Description: 'Gray only' },
  ]

  test('getOrderedStopsForRoute keeps one stop per id on the canonical route, in order', () => {
    const out = getOrderedStopsForRoute(stops, 31, TRANLOC_ROUTE_ALIASES)
    expect(out.map((s) => s.id)).toEqual(['1', '39.7768,-86.1739'])
    expect(out[0].name).toBe('Campus Center')
    expect(getOrderedStopsForRoute(stops, 33, TRANLOC_ROUTE_ALIASES)).toEqual([])
  })

  test('haversineMeters is roughly right for a short campus hop and zero for the same point', () => {
    const d = haversineMeters(39.7742, -86.1761, 39.7768, -86.1739)
    expect(d).toBeGreaterThan(330)
    expect(d).toBeLessThan(360)
    expect(haversineMeters(39.7742, -86.1761, 39.7742, -86.1761)).toBe(0)
  })

  test('nearestStopForVehicle picks the closest stop on the same canonical route', () => {
    const nearest = nearestStopForVehicle(stops, { RouteID: 18, Latitude: 39.7767, Longitude: -86.174 }, TRANLOC_ROUTE_ALIASES)
    expect(nearest?.description).toBe('Library')
    expect(nearest?.meters).toBeLessThan(20)
    expect(nearestStopForVehicle(stops, { RouteID: 'nope' }, TRANLOC_ROUTE_ALIASES)).toBeNull()
    expect(nearestStopForVehicle([], { RouteID: 31 }, TRANLOC_ROUTE_ALIASES)).toBeNull()
  })
})
