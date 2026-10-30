// Stops as places, for the widget reads (issue #549). TransLoc's stops feed
// lists one row per stop per route (RouteStopID), so Riverwalk Apartments is
// three rows, on Crimson, Gray and Orange, and a stop two routes serve from
// opposite sides of a street is two rows a few dozen meters apart. A place is
// the rows that share a name (case, spacing and dashes aside) within
// PLACE_RADIUS_METERS of each other, under a key made from the name, which
// survives TransLoc renumbering a route. Pure: feed rows in, places out.

import { haversineMeters } from './transitEta.mjs'
import { routeHours } from './transitHours.mjs'

/** Rows with one name this close together are one place (the farthest pair on 2026-10-29 was 63 m apart). */
export const PLACE_RADIUS_METERS = 150

const PLACE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

/** A stop name as shown: any dash as a hyphen, spacing collapsed. */
export function tidyStopName(name) {
  return String(name ?? '').replace(/\p{Pd}/gu, '-').replace(/\s+/g, ' ').trim()
}

/** The key a name makes: "Riverwalk Apartments" -> "riverwalk-apartments". */
export function placeSlug(name) {
  // Every run of other characters is one hyphen by the time the ends are cut.
  return tidyStopName(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** A `?stop=` value tidied for the lookup, or null when it cannot be a place key. */
export function normalizePlaceKey(value) {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return PLACE_KEY_RE.test(key) ? key : null
}

function hexColor(value) {
  const hex = String(value ?? '').trim().replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null
}

// "Route 1 - Crimson Estimated Times_april2025" -> number "1", name "Crimson".
// TransLoc writes the dash as an en dash on most routes; tidyStopName has made
// it a hyphen and every space run a single space by the time this reads it.
const ROUTE_NUMBER_RE = /\broute ?(\d+)/i
const ESTIMATED_TIMES = ' estimated times'

function describeRoute(row) {
  const description = tidyStopName(row?.Description)
  const m = ROUTE_NUMBER_RE.exec(description)
  if (!m) return { routeNum: null, routeName: description || null }
  let name = description.slice(m.index + m[0].length).split('_')[0].replace(/^[ -]+/, '').trim()
  if (name.toLowerCase().endsWith(ESTIMATED_TIMES)) name = name.slice(0, -ESTIMATED_TIMES.length).trim()
  else if (name.toLowerCase() === ESTIMATED_TIMES.trim()) name = ''
  return { routeNum: m[1], routeName: name || null }
}

/**
 * RouteID -> { routeId, routeNum, routeName, color, hours } for every row of
 * TransLoc's GetRoutes answer, with the hours of the route's number from
 * src/transitHours.mjs (null when none are on file). The routes shown on the
 * map are canonical; a hidden variant with the same number ("..._april2025")
 * maps to the shown route, the way the website's buildTranslocRouteIdMap
 * folds them, so a bus still reporting the old RouteID counts on its route.
 * When no row says whether it is shown, every row is its own route.
 */
export function buildRouteTable(routes) {
  const rows = (Array.isArray(routes) ? routes : []).filter((row) => Number.isFinite(Number(row?.RouteID)))
  const anyShown = rows.some((row) => row.IsVisibleOnMap === true)
  const own = (row) => {
    const { routeNum, routeName } = describeRoute(row)
    return { routeId: Number(row.RouteID), routeNum, routeName, color: hexColor(row.MapLineColor), hours: routeHours(routeNum) }
  }
  const shownByNum = new Map()
  for (const row of rows) {
    if (anyShown && row.IsVisibleOnMap !== true) continue
    const route = own(row)
    if (route.routeNum != null && !shownByNum.has(route.routeNum)) shownByNum.set(route.routeNum, route)
  }
  const table = new Map()
  for (const row of rows) {
    const route = own(row)
    const hidden = anyShown && row.IsVisibleOnMap !== true
    table.set(route.routeId, (hidden && shownByNum.get(route.routeNum)) || route)
  }
  return table
}

const byRoute = (a, b) =>
  (Number(a.routeNum ?? Infinity) - Number(b.routeNum ?? Infinity)) || a.routeId - b.routeId

/**
 * TransLoc's stop rows and route rows -> the index the widget reads use:
 *
 * - `places`: [{ key, name, lat, lon, routes, stops }] sorted by name, where
 *   `routes` is [{ routeId, routeNum, routeName, color, hours }] in route
 *   number order and `stops` is [{ routeId, routeStopId }], the route stops
 *   the place stands for (routeId canonical).
 * - `byKey`: key -> place.
 * - `routeStops`: canonical routeId -> its stops in feed order, deduped by
 *   RouteStopID like the website's getOrderedStopsForRoute, each
 *   { routeStopId, lat, lon, placeKey }: what the position estimate counts.
 *
 * A name shared by rows farther apart than PLACE_RADIUS_METERS makes several
 * places, keyed "<slug>", "<slug>-2" and so on in feed order. Rows without a
 * position or a name are left out.
 */
export function buildTransitIndex(stopRows, routeRows) {
  const table = buildRouteTable(routeRows)
  const groups = []
  const groupsBySlug = new Map()
  const routeStops = new Map()
  const routeOf = (rawId) =>
    table.get(Number(rawId)) ?? { routeId: Number(rawId), routeNum: null, routeName: null, color: null, hours: null }

  for (const row of Array.isArray(stopRows) ? stopRows : []) {
    const lat = Number(row?.Latitude)
    const lon = Number(row?.Longitude)
    const slug = placeSlug(row?.Description)
    if (!slug || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(Number(row?.RouteID))) continue
    const sameName = groupsBySlug.get(slug) ?? []
    let group = sameName.find((g) => haversineMeters(g.lat, g.lon, lat, lon) <= PLACE_RADIUS_METERS)
    if (!group) {
      group = { key: sameName.length ? `${slug}-${sameName.length + 1}` : slug, name: tidyStopName(row.Description), lat, lon, rows: [] }
      sameName.push(group)
      groupsBySlug.set(slug, sameName)
      groups.push(group)
    }
    group.rows.push({ row, lat, lon })

    const route = routeOf(row.RouteID)
    const routeStopId = row.RouteStopID != null && Number.isFinite(Number(row.RouteStopID)) ? Number(row.RouteStopID) : null
    const list = routeStops.get(route.routeId) ?? []
    if (routeStopId == null || !list.some((stop) => stop.routeStopId === routeStopId)) {
      list.push({ routeStopId, lat, lon, placeKey: group.key })
      routeStops.set(route.routeId, list)
    }
  }

  const places = groups.map((group) => {
    const routes = new Map()
    const stops = []
    for (const { row } of group.rows) {
      const route = routeOf(row.RouteID)
      routes.set(route.routeId, route)
      if (row.RouteStopID != null && Number.isFinite(Number(row.RouteStopID))) {
        stops.push({ routeId: route.routeId, routeStopId: Number(row.RouteStopID) })
      }
    }
    // The middle of the place's rows, to six places (about 10 cm).
    const round = (value) => Math.round(value * 1e6) / 1e6
    const lat = round(group.rows.reduce((sum, r) => sum + r.lat, 0) / group.rows.length)
    const lon = round(group.rows.reduce((sum, r) => sum + r.lon, 0) / group.rows.length)
    return { key: group.key, name: group.name, lat, lon, routes: [...routes.values()].sort(byRoute), stops }
  })
  places.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.key.localeCompare(b.key, 'en'))

  return { places, byKey: new Map(places.map((place) => [place.key, place])), routeStops, routeTable: table }
}

/** A place as GET /api/transit/places lists it, without the route stop ids. */
export function publicPlace({ key, name, lat, lon, routes }) {
  return { key, name, lat, lon, routes }
}
