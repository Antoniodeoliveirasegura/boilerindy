// The position-based arrival estimate (issue #549, from #44's re-plan): the
// stops between a bus and a stop on its route, times two minutes. Ported from
// the website's describeBusEta and findStopIndex (boilerindy-react's
// pages/Home.tsx), which count the same way for the dashboard's bus tile.
// It is the fallback for a route TransLoc gives no estimate for, and the
// arrivals answer marks it with `source: 'position'`. Pure.
//
// One change from the website: where a route passes the same spot twice, as
// at 404 Lot, whose inbound and outbound stops are 13 m apart, the nearest
// stop can be the wrong pass of the loop (on 2026-10-30 a Yellow bus arriving
// at 404 Lot-Inbound was counted from 404 Lot-Outbound, 18 minutes from
// Michigan and Blackford where TransLoc said 5). A moving bus's heading picks
// the pass there; a stopped bus reports heading 0, so it keeps the nearest.

export const AVG_STOP_MINUTES = 2
/** A bus counts as at a stop of its route within this distance, else it is between stops and gets no estimate. */
export const STOP_MATCH_METERS = 300
/** A route's stops this close to its nearest one are the same spot served on another pass. */
export const PAIRED_STOP_METERS = 60
/** A leg shorter than this has no direction to compare a heading with. */
const MIN_LEG_METERS = 5

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** The compass bearing from one { lat, lon } to another, 0 up to 360 clockwise from north. */
export function bearingDegrees(from, to) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLon = toRad(to.lon - from.lon)
  const y = Math.sin(dLon) * Math.cos(toRad(to.lat))
  const x = Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) - Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** How far a heading is from a bearing, 0 to 180 degrees. */
function turnDegrees(heading, bearing) {
  return Math.abs(((heading - bearing + 540) % 360) - 180)
}

/**
 * Index of the stop in `routeStops` ({ lat, lon }, in route order) nearest to
 * lat/lon, or -1 when none is within STOP_MATCH_METERS. With a moving bus's
 * `heading` (degrees from north), a stop of the route within
 * PAIRED_STOP_METERS of the nearest is the same spot on another pass, and the
 * pass whose way into or out of its stop lies closest to the heading wins.
 */
export function findStopIndex(routeStops, lat, lon, heading = null) {
  let bestIdx = -1
  let bestD = STOP_MATCH_METERS
  for (let i = 0; i < routeStops.length; i++) {
    const d = haversineMeters(routeStops[i].lat, routeStops[i].lon, lat, lon)
    if (d < bestD) {
      bestD = d
      bestIdx = i
    }
  }
  if (bestIdx === -1 || heading == null || !Number.isFinite(heading)) return bestIdx

  const n = routeStops.length
  const nearest = routeStops[bestIdx]
  const legTurn = (from, to) =>
    haversineMeters(from.lat, from.lon, to.lat, to.lon) < MIN_LEG_METERS ? Infinity : turnDegrees(heading, bearingDegrees(from, to))
  let pick = bestIdx
  let pickTurn = Infinity
  for (let i = 0; i < n; i++) {
    const stop = routeStops[i]
    if (haversineMeters(stop.lat, stop.lon, nearest.lat, nearest.lon) > PAIRED_STOP_METERS) continue
    const turn = Math.min(legTurn(routeStops[(i - 1 + n) % n], stop), legTurn(stop, routeStops[(i + 1) % n]))
    if (turn < pickTurn) {
      pickTurn = turn
      pick = i
    }
  }
  return pick
}

/**
 * Stops from the bus to the nearest of `targetIndexes` ahead of it on a loop
 * route: the bus is at the stop findStopIndex places it at (the nearest, or
 * the pass its heading points along), travels in route order and wraps
 * around, so a target just behind it is almost a whole loop away. Null when
 * the bus is not near any stop of the route or there is no target.
 */
export function stopsAway(routeStops, lat, lon, targetIndexes, heading = null) {
  if (!routeStops.length || !targetIndexes.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const busIdx = findStopIndex(routeStops, lat, lon, heading)
  if (busIdx === -1) return null
  const n = routeStops.length
  return Math.min(...targetIndexes.map((target) => (target - busIdx + n) % n))
}

/**
 * The position-based arrivals at a place on one route, soonest first: one per
 * bus on the route that is near a stop of it, `at` = `now` + stopsAway x
 * AVG_STOP_MINUTES (a bus at the place's stop arrives now). `vehicles` are
 * TransLoc vehicle rows already matched to the route; a row TransLoc flags
 * off its route is skipped. A moving bus's Heading breaks the tie between
 * two passes of one spot (findStopIndex).
 */
export function positionArrivals({ routeStops, targetIndexes, vehicles, now }) {
  const out = []
  for (const vehicle of vehicles) {
    if (vehicle?.IsOnRoute === false) continue
    const heading = Number(vehicle?.GroundSpeed) > 0 && vehicle?.Heading != null ? Number(vehicle.Heading) : null
    const stops = stopsAway(routeStops, Number(vehicle?.Latitude), Number(vehicle?.Longitude), targetIndexes, heading)
    if (stops == null) continue
    out.push({ at: now + stops * AVG_STOP_MINUTES * 60 * 1000, stopsAway: stops, vehicleId: vehicle?.VehicleID ?? null })
  }
  return out.sort((a, b) => a.at - b.at)
}
