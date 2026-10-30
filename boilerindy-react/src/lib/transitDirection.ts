import { haversineMeters } from './transitShared'

// Which way a bus goes, on the Transit map (owner, 2026-10-30): a moving bus's
// badge shows an arrow turned to its heading, and the picked route's line
// carries arrowheads the way its buses run. Leaflet never turns the map, so an
// arrow turned on screen stays true. TransLoc reports Heading 0 for a stopped
// bus (every stopped bus on 2026-10-30 did), which would point it north, so a
// stopped bus keeps its bus glyph instead.

/** The arrowheads along a route's line, one every this many metres. */
export const PATH_ARROW_SPACING_M = 250

type LatLon = readonly [number, number]

const toRadians = (degrees: number) => (degrees * Math.PI) / 180

/** The compass bearing from one point to the next, 0 up to 360 clockwise from north. */
export function bearingBetween([lat1, lon1]: LatLon, [lat2, lon2]: LatLon): number {
  const dLon = toRadians(lon2 - lon1)
  const y = Math.sin(dLon) * Math.cos(toRadians(lat2))
  const x = Math.cos(toRadians(lat1)) * Math.sin(toRadians(lat2)) - Math.sin(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** A moving bus's heading, 0 up to 360; null while it is stopped or the feed gives none. */
export function travelHeading(vehicle: { Heading?: unknown; GroundSpeed?: unknown }): number | null {
  const heading = Number(vehicle.Heading)
  if (vehicle.Heading == null || !Number.isFinite(heading) || !(Number(vehicle.GroundSpeed) > 0)) return null
  return ((heading % 360) + 360) % 360
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const

/** A heading in words, to the nearest of eight points, for a bus marker's name: "southeast". */
export function compassPoint(heading: number): string {
  return COMPASS[Math.round((((heading % 360) + 360) % 360) / 45) % 8]
}

export type PathArrow = { lat: number; lon: number; bearing: number }

/**
 * Where a line's arrowheads go: a point every `spacing` metres along it, the
 * first half a spacing in, each with the bearing of the stretch it is on. A
 * route's line runs the way its buses go, since each stop's MapPoints run from
 * it to the next stop (checked against the feed on 2026-10-30, every stop of
 * the six routes).
 */
export function pathArrows(points: readonly LatLon[], spacing = PATH_ARROW_SPACING_M): PathArrow[] {
  const arrows: PathArrow[] = []
  let walked = 0
  let next = spacing / 2
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]
    const to = points[i]
    const length = haversineMeters(from[0], from[1], to[0], to[1])
    if (length === 0) continue
    const bearing = bearingBetween(from, to)
    while (next <= walked + length) {
      const t = (next - walked) / length
      arrows.push({ lat: from[0] + (to[0] - from[0]) * t, lon: from[1] + (to[1] - from[1]) * t, bearing })
      next += spacing
    }
    walked += length
  }
  return arrows
}
