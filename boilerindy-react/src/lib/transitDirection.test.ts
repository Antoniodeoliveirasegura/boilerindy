import { expect, test } from 'vitest'
import { PATH_ARROW_SPACING_M, bearingBetween, compassPoint, pathArrows, travelHeading } from './transitDirection'
import { haversineMeters } from './transitShared'

// Which way a bus goes on the Transit map (2026-10-30). Points are [lat, lon].
const ONE_METRE_NORTH = 1 / 111_195
const CAMPUS: [number, number] = [39.7745, -86.1755]
const north = ([lat, lon]: [number, number], metres: number): [number, number] => [lat + metres * ONE_METRE_NORTH, lon]
const east = ([lat, lon]: [number, number], metres: number): [number, number] => [lat, lon + (metres * ONE_METRE_NORTH) / Math.cos((lat * Math.PI) / 180)]
const metres = (a: [number, number], b: { lat: number; lon: number }) => haversineMeters(a[0], a[1], b.lat, b.lon)

test('a moving bus has its heading, a stopped one, which the feed gives heading 0, has none', () => {
  // Buses from the feed of 2026-10-30: Gray at 23 mph, Crimson creeping, Yellow stopped.
  expect(travelHeading({ Heading: 93, GroundSpeed: 23.00017893378 })).toBe(93)
  expect(travelHeading({ Heading: 181, GroundSpeed: 0.99991052163 })).toBe(181)
  expect(travelHeading({ Heading: 0, GroundSpeed: 0 })).toBeNull()
  expect(travelHeading({ Heading: 370, GroundSpeed: 9 })).toBe(10)
  expect(travelHeading({ Heading: -90, GroundSpeed: 9 })).toBe(270)
  expect(travelHeading({ GroundSpeed: 9 })).toBeNull()
  expect(travelHeading({ Heading: 'north', GroundSpeed: 9 })).toBeNull()
  expect(travelHeading({ Heading: 90 })).toBeNull()
})

test('a heading in words, to the nearest of eight points', () => {
  expect([0, 93, 139, 181, 225, 270, 315, 359].map(compassPoint)).toEqual([
    'north', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north',
  ])
})

test('the compass bearing from one point to the next', () => {
  expect(bearingBetween(CAMPUS, north(CAMPUS, 100))).toBeCloseTo(0, 3)
  expect(bearingBetween(CAMPUS, east(CAMPUS, 100))).toBeCloseTo(90, 3)
  expect(bearingBetween(north(CAMPUS, 100), CAMPUS)).toBeCloseTo(180, 3)
  expect(bearingBetween(east(CAMPUS, 100), CAMPUS)).toBeCloseTo(270, 3)
})

test('an arrowhead every 250 m along a line, half a spacing in, pointing the way its points run', () => {
  expect(PATH_ARROW_SPACING_M).toBe(250)
  const straight = pathArrows([CAMPUS, north(CAMPUS, 1000)])
  expect(straight.map((arrow) => Math.round(metres(CAMPUS, arrow)))).toEqual([125, 375, 625, 875])
  for (const arrow of straight) expect(arrow.bearing).toBeCloseTo(0, 3)
  // North 300 m, then east 300 m: the second arrowhead, 375 m in, is on the eastward stretch.
  const corner = north(CAMPUS, 300)
  const bent = pathArrows([CAMPUS, corner, corner, east(corner, 300)])
  expect(bent.map((arrow) => Math.round(arrow.bearing))).toEqual([0, 90])
  expect(metres(corner, bent[1])).toBeCloseTo(75, 0)
  // Too short for one, or not a line.
  expect(pathArrows([CAMPUS, north(CAMPUS, 100)])).toEqual([])
  expect(pathArrows([CAMPUS])).toEqual([])
})
