// The next buses at a place, for GET /api/transit/arrivals (issue #549):
// TransLoc's own estimates first, and for a route TransLoc gives none for,
// the position-based estimate (src/transitEta.mjs), each arrival saying which
// it is. Pure: the router fetches, this reads.
//
// GetStopArrivalTimes as the JagLine relay answered it on 2026-10-30 (the
// sample is on #549, trimmed in test/fixtures/transloc-stop-arrival-times.json):
// one row per route stop with a bus coming, with RouteId and RouteStopId (the
// stops feed's RouteStopID) and a Times list of one entry per bus, carrying
// Seconds, EstimateTime, IsArriving, IsDeparted and VehicleId. With no bus
// running it answers []. An answer it cannot read leaves every route to the
// position estimate.

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
 * A relay time, "/Date(1793353923409)/" or with an offset as the vehicles
 * feed writes it, "/Date(1793375242000-0600)/", as epoch ms (the number as
 * is). Null for anything else.
 */
export function parseRelayDate(value) {
  const wcf = typeof value === 'string' ? /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value) : null
  return wcf ? Number(wcf[1]) : null
}

/**
 * GetStopArrivalTimes' answer -> [{ routeId, routeStopId, at, vehicleId,
 * arriving }] soonest first, `routeId` as the relay sent it. `at` is `now`
 * plus the time's Seconds, else its EstimateTime: the two agreed to the
 * second on 2026-10-30, but the vehicles feed's TimeStamp runs six hours
 * ahead, so the countdown, which does not lean on the relay's clock, comes
 * first. Only times a tracked bus carries are kept (an EstimateTime or a
 * VehicleId; a schedule-only time would be left out, and none came back),
 * departed ones are dropped, and so is anything due more than
 * ESTIMATE_GRACE_MS ago or ESTIMATE_HORIZON_MS ahead of `now`. With
 * `routeStopIds`, rows for other stops are ignored. Never throws: a shape it
 * does not know reads as no estimates.
 */
export function parseStopArrivalTimes(payload, { now, routeStopIds = null } = {}) {
  const rows = Array.isArray(payload) ? payload : []
  const wanted = routeStopIds ? new Set([...routeStopIds].map(Number)) : null
  const out = []
  for (const row of rows) {
    const routeId = finite(row?.RouteId)
    const routeStopId = finite(row?.RouteStopId)
    if (routeId == null || routeStopId == null || !Array.isArray(row.Times)) continue
    if (wanted && !wanted.has(routeStopId)) continue
    for (const time of row.Times) {
      if (!time || time.IsDeparted === true) continue
      const vehicleId = finite(time.VehicleId)
      const estimate = parseRelayDate(time.EstimateTime)
      if (estimate == null && !(vehicleId > 0)) continue
      const seconds = finite(time.Seconds)
      const at = seconds != null ? now + seconds * 1000 : estimate
      if (at == null || at < now - ESTIMATE_GRACE_MS || at > now + ESTIMATE_HORIZON_MS) continue
      out.push({ routeId, routeStopId, at, vehicleId, arriving: time.IsArriving === true })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** True when the answer had times in it and the parser could read none of them: the sign of a shape it does not know. */
export function unreadTimes(payload, parsed) {
  return parsed.length === 0 && Array.isArray(payload) && payload.some((row) => Array.isArray(row?.Times) && row.Times.length > 0)
}

/**
 * The arrivals answer for `place` (an entry of buildTransitIndex's places):
 *
 *   { place: { key, name, routes }, fetchedAt,
 *     arrivals: [{ routeId, routeNum, routeName, color, at, source, vehicleId }] }
 *
 * `estimates` are parseStopArrivalTimes rows (an empty list when TransLoc
 * gave none), `vehicles` GetMapVehiclePoints rows; a route at the place with
 * no estimate from TransLoc gets the position-based ones instead. Sorted by
 * `at`, at most MAX_PER_ROUTE per route and MAX_ARRIVALS in all; `at` and
 * `fetchedAt` are ISO 8601 to the second. `vehicleId` is the bus, the vehicles
 * feed's VehicleID (TransLoc's estimates name it too), or null when neither
 * did. A place with no bus coming answers `arrivals: []`.
 */
export function buildArrivals({ place, index, estimates, vehicles, now }) {
  const placeStops = new Set(place.stops.map((stop) => stop.routeStopId))
  const canonical = (rawRouteId) => index.routeTable.get(Number(rawRouteId))?.routeId ?? null
  const candidates = []
  for (const route of place.routes) {
    const fromTransloc = estimates
      .filter((e) => placeStops.has(e.routeStopId) && canonical(e.routeId) === route.routeId)
      .map((e) => ({ route, at: e.at, source: 'transloc', vehicleId: e.vehicleId }))
    if (fromTransloc.length) {
      candidates.push(...fromTransloc)
      continue
    }
    const routeStops = index.routeStops.get(route.routeId) ?? []
    const targetIndexes = routeStops.flatMap((stop, i) => (stop.placeKey === place.key ? [i] : []))
    const onRoute = vehicles.filter((vehicle) => canonical(vehicle?.RouteID) === route.routeId)
    for (const arrival of positionArrivals({ routeStops, targetIndexes, vehicles: onRoute, now })) {
      candidates.push({ route, at: arrival.at, source: 'position', vehicleId: arrival.vehicleId })
    }
  }

  candidates.sort((a, b) => a.at - b.at)
  const perRoute = new Map()
  const arrivals = []
  for (const { route, at, source, vehicleId } of candidates) {
    const count = perRoute.get(route.routeId) ?? 0
    if (count >= MAX_PER_ROUTE) continue
    perRoute.set(route.routeId, count + 1)
    const { routeId, routeNum, routeName, color } = route
    arrivals.push({ routeId, routeNum, routeName, color, at: isoSeconds(at), source, vehicleId: finite(vehicleId) })
    if (arrivals.length === MAX_ARRIVALS) break
  }

  return {
    place: { key: place.key, name: place.name, routes: place.routes },
    fetchedAt: isoSeconds(now),
    arrivals,
  }
}
