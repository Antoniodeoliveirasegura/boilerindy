import express from 'express'
import { runCampusEventsIngest } from '../campusEventsIngest.mjs'
import { isTransientFailure } from '../cronTick.mjs'
import { DB_FEATURES, isSchemaMissingError, respondSchemaMissing } from '../dbErrors.mjs'

// Shared campus events (issue #30): the ingest cron route. The Supabase pg_cron
// job in db/supabase-campus-events-ingest.sql calls it every 6 hours with the
// same bearer token as the source re-sync, and src/campusEventsIngest.mjs does
// the work: fetch the public campus calendars, plan the rows
// (src/sharedEvents.mjs), upsert them into campus_events and sweep what each
// source no longer lists. `?dryRun=1` (or `{ "dryRun": true }`) answers the
// rows a run would write and writes nothing. Nothing reads campus_events yet;
// the read path is a later change behind a flag. See
// docs/campus-events-ingest.md.

const ROUTE = 'POST /api/internal/campus-events/ingest'

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
 *   which says which BoilerLink organizations are Indianapolis ones; read only with Engage on
 * @param {boolean}  deps.engageEnabled          CAMPUS_EVENTS_ENGAGE: also read the BoilerLink and
 *   TheSpot event searches, whose robots.txt disallows /api/ (off by default)
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
      if (engageEnabled && clubDirectoryCache) {
        const { directory } = await clubDirectoryCache.get()
        if (directory?.ok) clubs = directory.clubs
      }
      const summary = await runCampusEventsIngest({ ...ingestOptions, client: supabase, dryRun, engageEnabled, clubs })
      const brief = summary.sources.filter((s) => s.enabled).map((s) => `${s.key}=${s.ok ? s.rows : 'failed'}`).join(' ')
      console.log(`[campus-events] ${dryRun ? 'dry run' : 'run'}: ${brief}, ${summary.totals.rows} rows${dryRun ? '' : `, ${summary.upserted} upserted`} in ${summary.durationMs} ms`)
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
