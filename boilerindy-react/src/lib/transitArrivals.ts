import { haversineMeters } from './transitShared'

// TransLoc's own times for the buses on Home (issue #549). The server's
// /api/transit/arrivals answers the next buses at a place, each naming its bus,
// so a Home row can say when its bus reaches the student's stop by TransLoc's
// estimate. Counting stops from where the bus is can put it on the wrong pass
// of the loop where a route serves one spot twice (404 Lot), which TransLoc's
// estimate does not. Answers are documented in docs/widget-reads.md.

export type TransitPlaceRoute = { routeId: number; routeNum: string; routeName: string; color: string }
export type TransitPlace = { key: string; name: string; lat: number; lon: number; routes: TransitPlaceRoute[] }
export type TransitArrival = TransitPlaceRoute & { at: string; source: 'transloc' | 'position'; vehicleId: number | null }
export type TransitArrivals = {
  place: { key: string; name: string; routes: TransitPlaceRoute[] }
  fetchedAt: string
  arrivals: TransitArrival[]
}

/** A place's route stops lie within this of each other (src/transitPlaces.mjs). */
const PLACE_RADIUS_M = 150

/** The place a stop is part of: the nearest place within 150 m of it, or null. */
export function placeForStop(places: readonly TransitPlace[], lat: number, lon: number): TransitPlace | null {
  let best: TransitPlace | null = null
  let bestD = PLACE_RADIUS_M
  for (const place of places) {
    const d = haversineMeters(lat, lon, place.lat, place.lon)
    if (d <= bestD) {
      bestD = d
      best = place
    }
  }
  return best
}

/**
 * When TransLoc says this bus reaches the place, as its Home row says it:
 * "6 min to your stop (Riverwalk Apartments)", or "Arriving at your stop (...)"
 * inside a minute. Null when TransLoc gave no time for this bus there, which
 * leaves the row to the stop count.
 */
export function translocEtaText(answer: TransitArrivals | undefined, vehicleId: unknown, now: number): string | null {
  if (!answer || !Array.isArray(answer.arrivals) || vehicleId == null) return null
  const arrival = answer.arrivals.find((a) => a.source === 'transloc' && a.vehicleId != null && String(a.vehicleId) === String(vehicleId))
  if (!arrival) return null
  const seconds = (Date.parse(arrival.at) - now) / 1000
  if (!Number.isFinite(seconds)) return null
  const stop = `your stop (${answer.place.name})`
  return seconds < 60 ? `Arriving at ${stop}` : `${Math.round(seconds / 60)} min to ${stop}`
}
