// The position-based arrival estimate (issue #549, from #44's re-plan): the
// stops between a bus and a stop on its route, times two minutes. Ported from
// the website's describeBusEta and findStopIndex (boilerindy-react's
// pages/Home.tsx), which count the same way for the dashboard's bus tile.
// It is the fallback for a route TransLoc gives no estimate for, and the
// arrivals answer marks it with `source: 'position'`. Pure.

export const AVG_STOP_MINUTES = 2
/** A bus counts as at a stop of its route within this distance, else it is between stops and gets no estimate. */
export const STOP_MATCH_METERS = 300

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Index of the stop in `routeStops` ({ lat, lon }, in route order) nearest to lat/lon, or -1 when none is within STOP_MATCH_METERS. */
export function findStopIndex(routeStops, lat, lon) {
  let bestIdx = -1
  let bestD = STOP_MATCH_METERS
  for (let i = 0; i < routeStops.length; i++) {
    const d = haversineMeters(routeStops[i].lat, routeStops[i].lon, lat, lon)
    if (d < bestD) {
      bestD = d
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Stops from the bus to the nearest of `targetIndexes` ahead of it on a loop
 * route: the bus is at the stop nearest to it, travels in route order and
 * wraps around, so a target just behind it is almost a whole loop away. Null
 * when the bus is not near any stop of the route or there is no target.
 */
export function stopsAway(routeStops, lat, lon, targetIndexes) {
  if (!routeStops.length || !targetIndexes.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const busIdx = findStopIndex(routeStops, lat, lon)
  if (busIdx === -1) return null
  const n = routeStops.length
  return Math.min(...targetIndexes.map((target) => (target - busIdx + n) % n))
}

/**
 * The position-based arrivals at a place on one route, soonest first: one per
 * bus on the route that is near a stop of it, `at` = `now` + stopsAway x
 * AVG_STOP_MINUTES (a bus at the place's stop arrives now). `vehicles` are
 * TransLoc vehicle rows already matched to the route; a row TransLoc flags
 * off its route is skipped.
 */
export function positionArrivals({ routeStops, targetIndexes, vehicles, now }) {
  const out = []
  for (const vehicle of vehicles) {
    if (vehicle?.IsOnRoute === false) continue
    const stops = stopsAway(routeStops, Number(vehicle?.Latitude), Number(vehicle?.Longitude), targetIndexes)
    if (stops == null) continue
    out.push({ at: now + stops * AVG_STOP_MINUTES * 60 * 1000, stopsAway: stops, vehicleId: vehicle?.VehicleID ?? null })
  }
  return out.sort((a, b) => a.at - b.at)
}
