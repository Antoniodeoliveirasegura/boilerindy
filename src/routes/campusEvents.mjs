import express from 'express'
import { applyDowntownSwitch, planPublicFreeFoodItems, readPublicFreeFoodRows } from '../campusEventsFeed.mjs'
import { runCampusEventsIngest } from '../campusEventsIngest.mjs'
import { isTransientFailure } from '../cronTick.mjs'
import { DB_FEATURES, isSchemaMissingError, respondDbError, respondSchemaMissing } from '../dbErrors.mjs'
import { enabledEngageSources } from '../sharedEvents.mjs'

// Shared campus events (issue #30): the ingest cron route, and the public
// free-food read behind a signed-out visitor's /free-food (issue #366). The
// Supabase pg_cron job in db/supabase-campus-events-ingest.sql calls the
// ingest every 6 hours with the same bearer token as the source re-sync, and
// src/campusEventsIngest.mjs does the work: fetch the public campus
// calendars, plan the rows (src/sharedEvents.mjs), upsert them into
// campus_events and sweep what each source no longer lists. `?dryRun=1` (or
// `{ "dryRun": true }`) answers the rows a run would write and writes nothing.
// With CAMPUS_EVENTS_CLASSIFY on, a real run also asks Jev about new and
// edited listings (src/campusEventsClassify.mjs), and with
// CAMPUS_EVENTS_DOWNTOWN on it reads White River State Park's calendar too
// (and with CAMPUS_EVENTS_LIBRARY on the Central Library's), which the
// free-food read then lists. See docs/campus-events-ingest.md and,
// for the read, docs/campus-events-feed.md.

const ROUTE = 'POST /api/internal/campus-events/ingest'

// One read of the free-food rows serves this process for a minute. The ingest
// writes them every 6 hours, so that costs nothing in freshness, and it holds
// the database to a read a minute however many visitors, or query strings
// that miss the edge cache, arrive.
const PUBLIC_FREE_FOOD_CACHE_KEY = 'campus-events:free-food'
const PUBLIC_FREE_FOOD_CACHE_MS = 60 * 1000
const PUBLIC_FREE_FOOD_DB_ERROR = { ...DB_FEATURES.campus_events, fallback: 'Could not load free food events. Please try again.' }

/**
 * The signed-out free-food read (issue #366), mounted by server.mjs in its
 * public reads block, before the session middleware, so it never sees a
 * session: GET /api/campus-events/free-food answers the shared campus events
 * with free food to anyone, from campus_events alone (src/campusEventsFeed.mjs),
 * and never a student's own calendar rows. The answer is the same for every
 * caller, so the edge may cache it; a failed read is never cached anywhere.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase               the Supabase client
 * @param {Function} deps.publicReadIpRateLimit  the per-address cap across the public reads
 * @param {Function} deps.publicReadRateLimit    the shared public-read bucket
 * @param {Function} deps.getCached              server.mjs's shared TTL cache (createStaleCache in
 *   src/upstreamFetch.mjs): never caches a failure, and serves the last good rows while a refresh fails
 * @param {boolean}  [deps.sharedEventsFeed]     CAMPUS_EVENTS_FEED: off answers no events and reads nothing,
 *   as the signed-in pages then list no shared rows either
 * @param {boolean}  [deps.downtownEnabled]      CAMPUS_EVENTS_DOWNTOWN: off leaves the downtown rows out
 *   (applyDowntownSwitch), as the signed-in pages do
 */
export function createCampusEventsPublicRouter({
  supabase,
  publicReadIpRateLimit,
  publicReadRateLimit,
  getCached,
  sharedEventsFeed = false,
  downtownEnabled = false,
}) {
  const router = express.Router()

  async function handlePublicFreeFood(_req, res) {
    try {
      const rows = sharedEventsFeed
        ? await getCached(PUBLIC_FREE_FOOD_CACHE_KEY, PUBLIC_FREE_FOOD_CACHE_MS, () => readPublicFreeFoodRows(supabase))
        : []
      // Planned per request, so a cached read still drops a listing once it is
      // over. A minute in the browser and five at the edge, which may serve the
      // expired copy while it refreshes, so a Render cold start does not stall
      // a visitor arriving from a shared link.
      res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
      res.json({ ok: true, items: applyDowntownSwitch(planPublicFreeFoodItems(rows), downtownEnabled) })
    } catch (error) {
      // An empty list here would read as "no free food" to every visitor.
      res.set('Cache-Control', 'no-store')
      respondDbError(res, error, PUBLIC_FREE_FOOD_DB_ERROR)
    }
  }

  router.get('/api/campus-events/free-food', publicReadIpRateLimit, publicReadRateLimit, handlePublicFreeFood)

  return router
}

function wantsDryRun(req) {
  const flag = String(req.query?.dryRun ?? '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(flag) || req.body?.dryRun === true
}

/**
 * @param {object}   deps
 * @param {object}   deps.supabase               the Supabase client
 * @param {string}   deps.PUSH_CRON_SECRET       the cron bearer token; empty leaves the route to the 404
 * @param {Function} deps.pushCronSecretMatches  checks an Authorization header against it
 * @param {Function} deps.warnCronTransient      server.mjs's warning for a transient database
 *   failure that survived its retry
 * @param {object}   deps.clubDirectoryCache     server.mjs's club directory (src/boilerlinkClubs.mjs),
 *   which says which BoilerLink organizations are Indianapolis ones; read only with BoilerLink on
 * @param {boolean|string[]} deps.engageEnabled  CAMPUS_EVENTS_ENGAGE through engageSourcesFromSetting:
 *   the Engage event searches to read as well (`boilerlink`, `thespot`), or `true` for both;
 *   both sites' robots.txt disallows /api/, and only Purdue has agreed (off by default)
 * @param {boolean} [deps.downtownEnabled]       CAMPUS_EVENTS_DOWNTOWN: White River State Park's calendar too
 *   (off by default); a run before README step 49 leaves it out
 * @param {boolean} [deps.libraryEnabled]        CAMPUS_EVENTS_LIBRARY: with the downtown switch on, the
 *   Central Library's calendar too (off by default, held for a permission email)
 * @param {Function|null} [deps.classify]        the Jev hook from createCampusEventsClassifier
 *   (CAMPUS_EVENTS_CLASSIFY with TYPESAFE_API_KEY), null when classification is off
 * @param {object}  [deps.ingestOptions]         passed to runCampusEventsIngest (tests hand in
 *   fetchImpl, sleep and now)
 */
export function createCampusEventsRouter({
  supabase,
  PUSH_CRON_SECRET,
  pushCronSecretMatches,
  warnCronTransient,
  clubDirectoryCache,
  engageEnabled = false,
  downtownEnabled = false,
  libraryEnabled = false,
  classify = null,
  ingestOptions = {},
}) {
  const router = express.Router()

  // One run at a time: the sweep of one run must not delete what an
  // overlapping run just wrote.
  let ingestInFlight = false
  router.post('/api/internal/campus-events/ingest', async (req, res, next) => {
    if (!PUSH_CRON_SECRET) return next()
    if (!pushCronSecretMatches(req.get('authorization'))) {
      return res.status(401).json({ error: { message: 'Invalid cron secret.', status: 401 } })
    }
    if (ingestInFlight) {
      return res.status(409).json({ error: { message: 'A campus events ingest is already running.', status: 409 } })
    }
    ingestInFlight = true
    try {
      const dryRun = wantsDryRun(req)
      let clubs = []
      // Only BoilerLink needs the directory: on TheSpot every organization is an Indianapolis one.
      if (enabledEngageSources(engageEnabled).has('boilerlink') && clubDirectoryCache) {
        const { directory } = await clubDirectoryCache.get()
        if (directory?.ok) clubs = directory.clubs
      }
      const summary = await runCampusEventsIngest({ ...ingestOptions, client: supabase, dryRun, engageEnabled, downtownEnabled, libraryEnabled, clubs, classify })
      // A downtown source left out before README step 49 reads as skipped.
      const brief = summary.sources
        .filter((s) => s.enabled)
        .map((s) => `${s.key}=${s.ok ? s.rows : s.schemaMissing ? 'skipped' : 'failed'}`)
        .join(' ')
      const jev = summary.classify?.mode
        ? `, jev ${summary.classify.mode}: ${summary.classify.reused} reused, ${summary.classify.asked} asked, ${summary.classify.failed} failed, ${summary.classify.deferred} left for the next run`
        : ''
      console.log(`[campus-events] ${dryRun ? 'dry run' : 'run'}: ${brief}, ${summary.totals.rows} rows${dryRun ? '' : `, ${summary.upserted} upserted`}${jev} in ${summary.durationMs} ms`)
      return res.json(summary)
    } catch (error) {
      if (isSchemaMissingError(error)) return respondSchemaMissing(res, DB_FEATURES.campus_events, error)
      if (isTransientFailure(error)) {
        warnCronTransient(ROUTE, error)
        return res.status(503).json({ error: { message: 'Campus events ingest skipped: the database is unavailable, the next run will retry.', status: 503 } })
      }
      console.error(`${ROUTE}:`, error?.message || error)
      return res.status(500).json({ error: { message: 'Campus events ingest failed.', status: 500 } })
    } finally {
      ingestInFlight = false
    }
  })

  return router
}
