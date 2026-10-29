// The next buses at a place, for GET /api/transit/arrivals (issue #549):
// TransLoc's own estimates first, and for a route TransLoc gives none for,
// the position-based estimate (src/transitEta.mjs), each arrival saying which
// it is. Pure: the router fetches, this reads.
//
// UNVERIFIED: no GetStopArrivalTimes answer has been seen from this agency's
// relay yet (it needs TRANSLOC_API_KEY; without one it answers 200 with an
// empty body). The parser follows the RideSystems shape that public clients
// of other agencies' JSONPRelay.svc read: rows with RouteID and RouteStopID
// (some spell them RouteId and RouteStopId) and a Times list whose entries
// carry Seconds, EstimateTime, IsArriving, IsDeparted and VehicleId. It is
// tested against a made-up fixture in that shape
// (test/fixtures/transloc-stop-arrival-times.UNVERIFIED.json), and anything
// it cannot read leaves the route to the position estimate. Check it against
// the sample on #549 before trusting `source: 'transloc'`.

import { isoSeconds } from './campusTime.mjs'
import { positionArrivals } from './transitEta.mjs'

export const MAX_PER_ROUTE = 2
export const MAX_ARRIVALS = 8
/** Estimates further ahead than this are dropped as noise. */
export const ESTIMATE_HORIZON_MS = 2 * 60 * 60 * 1000
/** A bus due a moment ago may still be at the stop. */
export const ESTIMATE_GRACE_MS = 60 * 1000

const finite = (value) => (value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null)

/**
 * A relay time as epoch ms: the WCF form "/Date(1793318149000-0600)/" (the
 * number is read as is; the relay's offsets disagree with its own clock, so
 * relative Seconds are preferred wherever they exist), an ISO string, or a
 * number of ms. Null for anything else.
 */
export function parseRelayDate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value) return null
  const wcf = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value)
  if (wcf) return Number(wcf[1])
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * GetStopArrivalTimes' answer -> [{ routeId, routeStopId, at, vehicleId,
 * arriving }] soonest first, `routeId` as the relay sent it. Only times a
 * tracked bus carries are kept (an EstimateTime or a VehicleId, not a
 * schedule-only row), departed ones are dropped, and so is anything due more
 * than ESTIMATE_GRACE_MS ago or ESTIMATE_HORIZON_MS ahead of `now`. With
 * `routeStopIds`, rows for other stops are ignored, in case the relay
 * ignores the filter. Never throws: a shape it does not know reads as no
 * estimates.
 */
export function parseStopArrivalTimes(payload, { now, routeStopIds = null } = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.d) ? payload.d : []
  const wanted = routeStopIds ? new Set([...routeStopIds].map(Number)) : null
  const out = []
  for (const row of rows) {
    const routeId = finite(row?.RouteID ?? row?.RouteId)
    const routeStopId = finite(row?.RouteStopID ?? row?.RouteStopId)
    const times = row?.Times ?? row?.times
    if (routeId == null || routeStopId == null || !Array.isArray(times)) continue
    if (wanted && !wanted.has(routeStopId)) continue
    for (const time of times) {
      if (!time || time.IsDeparted === true) continue
      const vehicleId = finite(time.VehicleId ?? time.VehicleID)
      const estimate = parseRelayDate(time.EstimateTime)
      if (estimate == null && !(vehicleId > 0)) continue
      const seconds = finite(time.Seconds)
      const at = seconds != null ? now + seconds * 1000 : estimate ?? (vehicleId > 0 ? parseRelayDate(time.Time) : null)
      if (at == null || at < now - ESTIMATE_GRACE_MS || at > now + ESTIMATE_HORIZON_MS) continue
      out.push({ routeId, routeStopId, at, vehicleId, arriving: time.IsArriving === true })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** True when the answer had times in it and the parser could read none of them: the sign of a shape it does not know. */
export function unreadTimes(payload, parsed) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.d) ? payload.d : []
  return parsed.length === 0 && rows.some((row) => Array.isArray(row?.Times ?? row?.times) && (row.Times ?? row.times).length > 0)
}

/**
 * The arrivals answer for `place` (an entry of buildTransitIndex's places):
 *
 *   { place: { key, name, routes }, fetchedAt,
 *     arrivals: [{ routeId, routeNum, routeName, color, at, source }] }
 *
 * `estimates` are parseStopArrivalTimes rows (an empty list when TransLoc
 * gave none), `vehicles` GetMapVehiclePoints rows; a route at the place with
 * no estimate from TransLoc gets the position-based ones instead. Sorted by
 * `at`, at most MAX_PER_ROUTE per route and MAX_ARRIVALS in all; `at` and
 * `fetchedAt` are ISO 8601 to the second. A place with no bus coming answers
 * `arrivals: []`.
 */
export function buildArrivals({ place, index, estimates, vehicles, now }) {
  const placeStops = new Set(place.stops.map((stop) => stop.routeStopId))
  const canonical = (rawRouteId) => index.routeTable.get(Number(rawRouteId))?.routeId ?? null
  const candidates = []
  for (const route of place.routes) {
    const fromTransloc = estimates
      .filter((e) => placeStops.has(e.routeStopId) && canonical(e.routeId) === route.routeId)
      .map((e) => ({ route, at: e.at, source: 'transloc' }))
    if (fromTransloc.length) {
      candidates.push(...fromTransloc)
      continue
    }
    const routeStops = index.routeStops.get(route.routeId) ?? []
    const targetIndexes = routeStops.flatMap((stop, i) => (stop.placeKey === place.key ? [i] : []))
    const onRoute = vehicles.filter((vehicle) => canonical(vehicle?.RouteID) === route.routeId)
    for (const arrival of positionArrivals({ routeStops, targetIndexes, vehicles: onRoute, now })) {
      candidates.push({ route, at: arrival.at, source: 'position' })
    }
  }

  candidates.sort((a, b) => a.at - b.at)
  const perRoute = new Map()
  const arrivals = []
  for (const { route, at, source } of candidates) {
    const count = perRoute.get(route.routeId) ?? 0
    if (count >= MAX_PER_ROUTE) continue
    perRoute.set(route.routeId, count + 1)
    const { routeId, routeNum, routeName, color } = route
    arrivals.push({ routeId, routeNum, routeName, color, at: isoSeconds(at), source })
    if (arrivals.length === MAX_ARRIVALS) break
  }

  return {
    place: { key: place.key, name: place.name, routes: place.routes },
    fetchedAt: isoSeconds(now),
    arrivals,
  }
}
