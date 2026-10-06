import express from 'express'
import { parseClubSearchParams, searchClubDirectory } from '../boilerlinkClubs.mjs'
import { fetchParkingStatus } from '../parkingStatus.mjs'
import { UpstreamError, fetchUpstreamJson } from '../upstreamFetch.mjs'

// Campus: the TransLoc shuttle proxies, live garage availability and the club
// directory search. Moved out of server.mjs as a feature router (issue #191)
// with the handlers unchanged. All five routes are session-free public reads
// (issue #250), so there is only the public router, mounted ahead of the
// session middleware.

// TransLoc API proxy endpoints (to avoid CORS issues)
const TRANSLOC_API = 'https://iuindianapolis.transloc.com/Services/JSONPRelay.svc'
const TRANSLOC_API_KEY = process.env.TRANSLOC_API_KEY
const TRANSLOC_STATIC_TTL_MS = 10 * 60 * 1000 // routes/stops barely change
const TRANSLOC_VEHICLES_TTL_MS = 5 * 1000 // live positions: short, just dedupes bursts
const TRANSLOC_TIMEOUT_MS = 8000

// A TransLoc failure after the first successful fill is served from the cache
// (see getCached); this only answers when there is nothing good to serve.
function respondTranslocError(res, what, error) {
  if (error instanceof UpstreamError) {
    console.error(`TransLoc ${what}:`, error.message)
    return res.status(502).json({ error: { message: 'Transit data is temporarily unavailable.', status: 502 } })
  }
  console.error(`TransLoc ${what} error:`, error?.message || error)
  return res.status(500).json({ error: { message: `Failed to fetch ${what} data.`, status: 500 } })
}

// Fail closed when the key isn't configured rather than calling TransLoc with an
// undefined key (and caching the error). Transit requires TRANSLOC_API_KEY to be set.
function translocReady(res) {
  if (!TRANSLOC_API_KEY) {
    res.status(503).json({ error: { message: 'Transit is not configured.', status: 503 } })
    return false
  }
  return true
}

// Live garage availability (issue #14): IU Parking's public lot-count page,
// parsed server-side (src/parkingStatus.mjs) and cached so the upstream sees
// at most one request per TTL no matter how many students are looking. The
// module never throws: an unreachable page yields a degraded snapshot with the
// static garage list and status 'unknown'. See docs/parking-status.md.
const PARKING_CACHE_MS = Math.max(15_000, Number(process.env.PARKING_STATUS_CACHE_MS) || 60_000)

/**
 * The campus public reads, mounted by server.mjs in its public reads block,
 * before the session middleware, where the app.get lines used to be, so the
 * responses never carry the session cookie and the edge can cache them. Paths
 * stay absolute (`/api/transit/stops`) so docs/RATE_LIMITS.md and its guard
 * test read the same whether a route lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {Function} deps.transitVehiclesIpRateLimit the per-address cap on vehicle polling
 * @param {Function} deps.transitVehiclesRateLimit   the vehicle polling bucket
 * @param {Function} deps.publicReadIpRateLimit      the per-address cap across the public reads
 * @param {Function} deps.publicReadRateLimit        the shared public-read bucket
 * @param {Function} deps.clubsReadRateLimit         the club search bucket
 * @param {Function} deps.getCached                  server.mjs's shared TTL cache, which the
 *   spotlight route uses too
 * @param {object}   deps.clubDirectoryCache         the BoilerLink directory cache built in
 *   server.mjs, which also refreshes it after startup
 */
export function createCampusPublicRouter({
  transitVehiclesIpRateLimit,
  transitVehiclesRateLimit,
  publicReadIpRateLimit,
  publicReadRateLimit,
  clubsReadRateLimit,
  getCached,
  clubDirectoryCache,
}) {
  const router = express.Router()

  async function handleTransitVehicles(_req, res) {
    if (!translocReady(res)) return
    try {
      const data = await getCached('transit:vehicles', TRANSLOC_VEHICLES_TTL_MS, () =>
        fetchUpstreamJson('TransLoc', `${TRANSLOC_API}/GetMapVehiclePoints?apiKey=${TRANSLOC_API_KEY}&isPublicMap=true`, {
          timeoutMs: TRANSLOC_TIMEOUT_MS,
        }),
      )
      // Public data, cached 5 s here anyway: let browsers and Vercel's edge (the
      // /api rewrite) absorb the 10 s polling so repeats never reach this process.
      // stale-while-revalidate lets the edge answer a poll from the expired copy
      // while it refreshes, so a Render cold start does not stall every open map.
      res.set('Cache-Control', 'public, max-age=10, s-maxage=10, stale-while-revalidate=20')
      res.json(data)
    } catch (error) {
      respondTranslocError(res, 'vehicles', error)
    }
  }

  async function handleTransitStops(_req, res) {
    if (!translocReady(res)) return
    try {
      const data = await getCached('transit:stops', TRANSLOC_STATIC_TTL_MS, () =>
        fetchUpstreamJson('TransLoc', `${TRANSLOC_API}/GetStops?apiKey=${TRANSLOC_API_KEY}`, { timeoutMs: TRANSLOC_TIMEOUT_MS }),
      )
      // Stops and routes change a few times a year: a minute in the browser, ten
      // at the edge, and the edge may serve the expired copy while it refreshes.
      res.set('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=600')
      res.json(data)
    } catch (error) {
      respondTranslocError(res, 'stops', error)
    }
  }

  async function handleTransitRoutes(_req, res) {
    if (!translocReady(res)) return
    try {
      const data = await getCached('transit:routes', TRANSLOC_STATIC_TTL_MS, () =>
        fetchUpstreamJson('TransLoc', `${TRANSLOC_API}/GetRoutes?apiKey=${TRANSLOC_API_KEY}`, { timeoutMs: TRANSLOC_TIMEOUT_MS }),
      )
      res.set('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=600')
      res.json(data)
    } catch (error) {
      respondTranslocError(res, 'routes', error)
    }
  }

  async function handleParkingGarages(_req, res) {
    try {
      const data = await getCached('parking:garages', PARKING_CACHE_MS, () => fetchParkingStatus())
      // The snapshot is already shared for PARKING_CACHE_MS in this process, so a
      // short public lifetime costs nothing in freshness and lets the edge absorb
      // a whole lot of phones refreshing the garage list at once (issue #250).
      res.set('Cache-Control', 'public, max-age=15, s-maxage=30')
      res.json(data)
    } catch (error) {
      console.error('Parking status error:', error)
      res.status(500).json({ error: 'Failed to fetch parking status' })
    }
  }

  // Club directory search (issue #16). The cache is built in server.mjs; see
  // the comment there and docs/clubs.md.
  async function handleClubs(req, res) {
    try {
      const params = parseClubSearchParams(req.query)
      const { directory, stale } = await clubDirectoryCache.get()
      res.set('Cache-Control', 'public, max-age=300')
      res.json(searchClubDirectory(directory, params, { stale }))
    } catch (error) {
      console.error('Club directory error:', error)
      res.status(500).json({ error: 'Failed to load the club directory' })
    }
  }

  router.get('/api/transit/vehicles', transitVehiclesIpRateLimit, transitVehiclesRateLimit, handleTransitVehicles)
  router.get('/api/transit/stops', publicReadIpRateLimit, publicReadRateLimit, handleTransitStops)
  router.get('/api/transit/routes', publicReadIpRateLimit, publicReadRateLimit, handleTransitRoutes)
  router.get('/api/parking/garages', publicReadIpRateLimit, publicReadRateLimit, handleParkingGarages)
  router.get('/api/clubs', clubsReadRateLimit, handleClubs)

  return router
}
