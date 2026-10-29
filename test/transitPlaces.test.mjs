import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PLACE_RADIUS_METERS,
  buildRouteTable,
  buildTransitIndex,
  normalizePlaceKey,
  placeSlug,
  publicPlace,
  tidyStopName,
} from '../src/transitPlaces.mjs'
import { haversineMeters } from '../src/transitEta.mjs'

// Issue #549: TransLoc's stops feed lists one row per stop per route, and a
// widget's stop is a place. The fixtures are the JagLine feeds as BoilerIndy's
// own /api/transit/stops and /api/transit/routes served them on 2026-10-29,
// with MapPoints and the other unused fields dropped, and the en dashes
// TransLoc writes in some names ("Route 1 <en dash> Crimson") turned into
// hyphens, which this repository bans; the tests below build the en dash
// with String.fromCharCode where it matters.

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const STOPS = load('transloc-stops.json')
const ROUTES = load('transloc-routes.json')
const EN_DASH = String.fromCharCode(0x2013)

const routeLabel = (route) => `${route.routeNum} ${route.routeName}`

test('the route table names every RouteID and folds hidden variants onto the route shown on the map', () => {
  const table = buildRouteTable(ROUTES)
  assert.deepEqual(table.get(31), { routeId: 31, routeNum: '1', routeName: 'Crimson', color: '#990000' })
  assert.deepEqual(table.get(19), { routeId: 19, routeNum: '2', routeName: 'Gray', color: '#83786F' })
  assert.deepEqual(table.get(34), { routeId: 34, routeNum: '7', routeName: 'Orange', color: '#E68217' })
  // "Route 1 - Crimson Estimated Times_april2025", hidden: a bus reporting it is on Crimson.
  assert.deepEqual(table.get(18), table.get(31))
  assert.deepEqual(table.get(29), table.get(34))
  assert.equal(table.get(3).routeId, 32)
  // Hidden with no shown route of its number, and a charter with no number: their own.
  assert.deepEqual(table.get(6), { routeId: 6, routeNum: '6', routeName: 'Green', color: '#008264' })
  assert.deepEqual(table.get(16), { routeId: 16, routeNum: null, routeName: 'Charter 1', color: '#A800A8' })
  assert.equal(table.size, ROUTES.length)
})

test('route descriptions read with the en dash TransLoc writes, and every row is its own route when none says it is shown', () => {
  const table = buildRouteTable([
    { RouteID: 31, Description: `Route 1 ${EN_DASH} Crimson Estimated Times`, MapLineColor: '990000' },
    { RouteID: 18, Description: `Route 1 ${EN_DASH} Crimson Estimated Times_april2025`, MapLineColor: 'not a color' },
    { RouteID: 'x', Description: 'No id' },
  ])
  assert.deepEqual(table.get(31), { routeId: 31, routeNum: '1', routeName: 'Crimson', color: '#990000' })
  assert.deepEqual(table.get(18), { routeId: 18, routeNum: '1', routeName: 'Crimson', color: null })
  assert.equal(table.size, 2)
  assert.equal(buildRouteTable(null).size, 0)
})

test('names are tidied and keyed: dashes, spacing and case aside', () => {
  assert.equal(tidyStopName(`Ceramics${EN_DASH}Outbound`), 'Ceramics-Outbound')
  assert.equal(tidyStopName('  Herron off New York   Street '), 'Herron off New York Street')
  assert.equal(placeSlug('Riverwalk Apartments'), 'riverwalk-apartments')
  assert.equal(placeSlug(`Ceramics${EN_DASH}Outbound`), placeSlug('Ceramics-Outbound'))
  assert.equal(placeSlug('University and New York (SB)'), 'university-and-new-york-sb')
  assert.equal(placeSlug('Blake & New York'), 'blake-and-new-york')
  assert.equal(placeSlug('PCC -Outbound'), 'pcc-outbound')
  assert.equal(placeSlug('  '), '')
})

test('the feed groups into places: Riverwalk Apartments is one place on Crimson, Gray and Orange', () => {
  const { places, byKey } = buildTransitIndex(STOPS, ROUTES)
  assert.equal(places.length, 41)
  assert.equal(byKey.size, 41)
  const riverwalk = byKey.get('riverwalk-apartments')
  assert.equal(riverwalk.name, 'Riverwalk Apartments')
  assert.deepEqual(riverwalk.routes.map(routeLabel), ['1 Crimson', '2 Gray', '7 Orange'])
  assert.deepEqual(riverwalk.stops, [
    { routeId: 19, routeStopId: 243 },
    { routeId: 31, routeStopId: 369 },
    { routeId: 34, routeStopId: 409 },
  ])
  assert.deepEqual([riverwalk.lat, riverwalk.lon], [39.773819, -86.185254])
  // Sorted by name for the picker.
  const names = places.map((p) => p.name)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')))
})

test('a stop served from the other side of the street is the same place', () => {
  const { byKey } = buildTransitIndex(STOPS, ROUTES)
  const blackford = byKey.get('michigan-and-blackford')
  assert.deepEqual(blackford.routes.map(routeLabel), ['1 Crimson', '2 Gray', '3 Yellow', '5 Purple', '7 Orange'])
  // Gray's row stands about 33 m from the others.
  const gray = STOPS.find((row) => row.RouteStopID === 214)
  const crimson = STOPS.find((row) => row.RouteStopID === 365)
  const apart = haversineMeters(gray.Latitude, gray.Longitude, crimson.Latitude, crimson.Longitude)
  assert.ok(apart > 25 && apart < 40, `${apart}`)
  // The widest same-name pair in the feed, New York and Barnhill, is about 63 m.
  assert.deepEqual(byKey.get('new-york-and-barnhill').routes.map(routeLabel), ['1 Crimson', '2 Gray', '7 Orange'])
  // Similar names are not merged.
  assert.ok(byKey.has('michigan-and-university'))
  assert.ok(byKey.has('university-and-michigan'))
  assert.ok(byKey.has('pcc-inbound') && byKey.has('pcc-outbound'))
  // Trailing spaces in the feed's names do not show.
  assert.equal(byKey.get('herron-off-new-york-street').name, 'Herron off New York Street')
  assert.equal(byKey.get('16-tech-outbound').name, '16 Tech-Outbound')
})

test('one name far apart makes separate places with numbered keys, and bad rows are left out', () => {
  assert.equal(PLACE_RADIUS_METERS, 150)
  const rows = [
    { Description: 'Campus Center', Latitude: 39.7742, Longitude: -86.1757, RouteID: 33, RouteStopID: 1 },
    { Description: 'CAMPUS CENTER ', Latitude: 39.7743, Longitude: -86.1757, RouteID: 31, RouteStopID: 2 },
    // About 1.1 km north: another stop with the same name.
    { Description: 'Campus  Center', Latitude: 39.7842, Longitude: -86.1757, RouteID: 31, RouteStopID: 3 },
    { Description: 'No position', RouteID: 31, RouteStopID: 4 },
    { Description: '', Latitude: 39.78, Longitude: -86.17, RouteID: 31, RouteStopID: 5 },
  ]
  const { places } = buildTransitIndex(rows, ROUTES)
  assert.deepEqual(
    places.map((p) => [p.key, p.name, p.stops.map((s) => s.routeStopId)]),
    [
      ['campus-center', 'Campus Center', [1, 2]],
      ['campus-center-2', 'Campus Center', [3]],
    ],
  )
})

test('each route keeps its stops in feed order with their places, for the position estimate', () => {
  const { routeStops } = buildTransitIndex(STOPS, ROUTES)
  const crimson = routeStops.get(31)
  assert.deepEqual(crimson.map((s) => s.placeKey), [
    'herron-off-new-york-street',
    'vermont-and-california',
    'michigan-and-blackford',
    'michigan-and-university',
    'long-hall',
    'ball-hall',
    'michigan-and-eskenazi',
    'riverwalk-apartments',
    'porto-alegre-and-limestone',
    'new-york-and-barnhill',
    'new-york-and-university',
  ])
  assert.deepEqual(crimson[7], { routeStopId: 369, lat: 39.773819, lon: -86.185254, placeKey: 'riverwalk-apartments' })
  assert.deepEqual([...routeStops.keys()].sort((a, b) => a - b), [19, 27, 31, 32, 33, 34])
})

test('publicPlace leaves the route stop ids out', () => {
  const { byKey } = buildTransitIndex(STOPS, ROUTES)
  const shown = publicPlace(byKey.get('campus-center'))
  assert.deepEqual(shown, {
    key: 'campus-center',
    name: 'Campus Center',
    lat: 39.774177,
    lon: -86.17567,
    routes: [{ routeId: 33, routeNum: '5', routeName: 'Purple', color: '#66435A' }],
  })
})

test('normalizePlaceKey accepts a key and nothing else', () => {
  assert.equal(normalizePlaceKey('riverwalk-apartments'), 'riverwalk-apartments')
  assert.equal(normalizePlaceKey(' Riverwalk-Apartments '), 'riverwalk-apartments')
  assert.equal(normalizePlaceKey('16-tech-inbound'), '16-tech-inbound')
  assert.equal(normalizePlaceKey(''), null)
  assert.equal(normalizePlaceKey('-leading'), null)
  assert.equal(normalizePlaceKey('riverwalk apartments'), null)
  assert.equal(normalizePlaceKey('../etc'), null)
  assert.equal(normalizePlaceKey('a'.repeat(81)), null)
  assert.equal(normalizePlaceKey(['riverwalk-apartments']), null)
  assert.equal(normalizePlaceKey(undefined), null)
})
