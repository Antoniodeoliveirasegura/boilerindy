import crypto from 'node:crypto'
import express from 'express'
import ical from 'node-ical'
import { createCalendarItemStore } from '../calendarItemStore.mjs'
import { isTransientFailure, retryOnceIfTransient, runCronTick } from '../cronTick.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import {
  cancelCalendarCapture,
  getCalendarCaptureJob,
  isCalendarAutomationEnabled,
  startCalendarCapture,
} from '../purdueCalendarAutomation.mjs'
import { classifyFetchError, detectTimezoneFromFeed, expandRecurringEvents, icalText, planSync } from '../scheduleSync.mjs'
import { runSourceResync } from '../sourceResync.mjs'
import { assertHostAllowed, assertSafeHttpUrl, safeFetchIcsText } from '../urlSafety.mjs'

// Linked calendar sources (issues #12 and #120): connecting a Brightspace or
// Purdue Timetabling iCal feed, syncing and deleting it, the dev-only debug
// and Purdue auto-capture routes, and the hourly re-sync the Supabase pg_cron
// job calls with the cron bearer token (docs/source-resync.md). Moved out of
// server.mjs as a feature router (issue #191) with the handlers unchanged
// apart from nowIso() and makeId() inlined. The re-sync route sat apart from
// the others there, after the Sentry warnings; it now mounts with them, and
// no route in between matched its path, so its answers are unchanged.

function validateSourceUrl(sourceUrl) {
  return assertSafeHttpUrl(sourceUrl)
}

// Hard host allowlist per schedule provider: the ONLY line of defense left once a
// URL passes assertSafeHttpUrl, and what stops an attacker supplying a rebindable
// hostname. A source type absent from this map is rejected (fail closed).
const SCHEDULE_SOURCE_HOSTS = {
  purdue_schedule_ical: ['purdue.edu'],
  brightspace_ical: ['brightspace.com', 'd2l.com', 'desire2learn.com'],
}

/**
 * The linked source routes and the source re-sync cron route, mounted by
 * server.mjs where the source routes used to be. Paths stay absolute
 * (`/api/me/sources`) so docs/RATE_LIMITS.md and its guard test read the same
 * whether a route lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase               the Supabase client
 * @param {Function} deps.requireAuth            loads req.currentUser or answers 401
 * @param {boolean}  deps.isProduction           hides the debug and auto-capture routes (404)
 * @param {boolean}  deps.purdueLinkingEnabled   false when PURDUE_AUTH_MODE is off: the Purdue
 *   schedule routes then need no linked Purdue identity
 * @param {object}   deps.onboardingSummaryCache server.mjs's one instance (src/onboardingSummaryCache.mjs),
 *   invalidated when a source is created, synced or deleted
 * @param {Function} deps.warnFeedTransient      server.mjs's Sentry warning for a feed host's transient failure
 * @param {Function} deps.sourceSyncRateLimit    the source create and sync limiter (source-sync)
 * @param {Function} deps.userWriteRateLimit     the shared per-user write limiter (source delete)
 * @param {string}   deps.PUSH_CRON_SECRET       the cron bearer token; empty leaves the re-sync route to the 404
 * @param {Function} deps.pushCronSecretMatches  checks an Authorization header against it
 * @param {Function} deps.warnCronTransient      server.mjs's warning for a transient failure that
 *   survived the tick's retry; the push router is handed these three too
 */
export function createSourcesRouter({
  supabase,
  requireAuth,
  isProduction,
  purdueLinkingEnabled,
  onboardingSummaryCache,
  warnFeedTransient,
  sourceSyncRateLimit,
  userWriteRateLimit,
  PUSH_CRON_SECRET,
  pushCronSecretMatches,
  warnCronTransient,
}) {
  const router = express.Router()

  function requirePurdueLinked(req, res, next) {
    // Linking off: calendar sources don't require a linked Purdue identity.
    if (!purdueLinkingEnabled) return next()
    if (!req.currentUser?.purdue_email) {
      return res.status(400).json({
        error: {
          message: 'Link your Purdue account before connecting Purdue schedule data.',
          status: 400,
        },
      })
    }
    next()
  }

  async function listSourcesForUser(userId) {
    const { data, error } = await supabase
      .from('linked_sources')
      .select('id, source_type, label, source_url, status, last_synced_at, last_error, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) return []
    return data.map(row => ({
      id: row.id,
      sourceType: row.source_type,
      label: row.label,
      sourceUrl: row.source_url,
      status: row.status,
      lastSyncedAt: row.last_synced_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  async function getSourceForUser(sourceId, userId) {
    const { data, error } = await supabase
      .from('linked_sources')
      .select('*')
      .eq('id', sourceId)
      .eq('user_id', userId)
      .single()

    if (error || !data) return null
    return data
  }

  // ── Schedule sync (imperative shell) ─────────────────────────────────────────
  // The pure plan lives in scheduleSync.mjs; this shell owns the fetch, the
  // database writes (via calendarItemStore), and item identity stamping.
  const calendarItemStore = createCalendarItemStore(supabase)

  // retryTransient: the background re-sync gives a transient feed failure one
  // more try before marking the source `error` (Sentry BOILERINDY-API-8). The
  // Sync buttons leave it off so a student is not kept waiting on a dead host.
  async function runScheduleSync(source, { retryTransient = false } = {}) {
    const syncedAt = new Date().toISOString()
    const sourceId = source.id

    let eventsByKey
    try {
      const fetchFeed = () => safeFetchIcsText(source.source_url)
      const icsText = retryTransient
        ? await retryOnceIfTransient('[runScheduleSync] source=' + sourceId, fetchFeed)
        : await fetchFeed()
      eventsByKey = await ical.async.parseICS(icsText)
    } catch (fetchError) {
      const classified = classifyFetchError(fetchError)
      if (isTransientFailure(fetchError)) warnFeedTransient(sourceId, fetchError)
      else console.error('[runScheduleSync] Fetch failed for source=' + sourceId + ':', fetchError?.message || fetchError)
      await calendarItemStore.setStatus(sourceId, classified.status, classified.message)
      throw new Error(classified.message)
    }

    const plan = planSync(eventsByKey, source)

    // Empty feed parsed cleanly: leave any existing items untouched (prior behaviour).
    if (plan.meta.rawCount === 0) {
      await calendarItemStore.setStatus(sourceId, plan.sourceStatus, plan.statusMessage, { markSynced: true })
      return { syncedAt, itemCount: 0, warning: plan.meta.warning }
    }

    try {
      await calendarItemStore.replaceItems(sourceId, plan.itemsToInsert)
    } catch (insertError) {
      await calendarItemStore.setStatus(sourceId, 'error', 'Failed to save events: ' + insertError.message)
      throw new Error('Failed to save calendar events: ' + insertError.message)
    }

    // The class count may have changed; drop the cached onboarding summary so the
    // post-sync session re-read reflects it (issue #111).
    onboardingSummaryCache.invalidate(source.user_id)

    await calendarItemStore.setStatus(sourceId, plan.sourceStatus, plan.statusMessage, { markSynced: true })

    console.log('[runScheduleSync] source=' + sourceId + ': ' + plan.meta.itemCount + ' items saved (' + plan.meta.skippedCount + ' skipped, ' + plan.meta.duplicateCount + ' duplicates removed)')

    return {
      syncedAt,
      itemCount: plan.meta.itemCount,
      skippedCount: plan.meta.skippedCount,
      timezone: plan.meta.timezone,
    }
  }

  async function createScheduleSource(userId, { icsUrl, label, sourceType = 'purdue_schedule_ical' }) {
    const allowedHosts = SCHEDULE_SOURCE_HOSTS[sourceType]
    if (!allowedHosts) {
      throw new Error('That calendar provider is not allowed.')
    }
    assertHostAllowed(icsUrl, allowedHosts)
    const sourceUrl = await validateSourceUrl(icsUrl)
    const timestamp = new Date().toISOString()
    const id = crypto.randomUUID()

    const { data, error } = await supabase
      .from('linked_sources')
      .insert({
        id,
        user_id: userId,
        source_type: sourceType,
        label: (label || 'Schedule').trim() || 'Schedule',
        source_url: sourceUrl,
        status: 'pending',
        created_at: timestamp,
        updated_at: timestamp
      })
      .select()
      .single()

    if (error) throw new Error(error.message)
    onboardingSummaryCache.invalidate(userId)
    return data
  }

  router.get('/api/me/sources', requireAuth, async (req, res) => {
    res.json({ sources: await listSourcesForUser(req.currentUser.id) })
  })

  // Debug endpoint to diagnose calendar import issues (disabled in production)
  router.get('/api/debug/source/:sourceId', requireIdParam('sourceId'), requireAuth, async (req, res) => {
    if (isProduction) {
      return res.status(404).json({ error: { message: 'Not found.', status: 404 } })
    }

    const source = await getSourceForUser(req.params.sourceId, req.currentUser.id)
    if (!source) {
      return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
    }

    try {
      const icsText = await safeFetchIcsText(source.source_url)
      const eventsByKey = await ical.async.parseICS(icsText)
      const rawEvents = Object.values(eventsByKey).filter((item) => item?.type === 'VEVENT')
      const detectedTimezone = detectTimezoneFromFeed(eventsByKey)
      
      // Get first 5 raw events with their key properties
      const sampleEvents = rawEvents.slice(0, 5).map(e => ({
        // Coerce node-ical's object-shaped text (SUMMARY;LANGUAGE=…) so the debug
        // output shows the title the sync would actually store, not "[object Object]".
        summary: icalText(e.summary),
        start: e.start,
        startType: typeof e.start,
        startTz: e.start?.tz,
        end: e.end,
        hasRrule: !!e.rrule,
        rruleStr: e.rrule?.toString?.()?.slice(0, 200),
        uid: e.uid?.slice(0, 50),
      }))
      
      // Expand and get first 10 expanded events
      const expanded = expandRecurringEvents(rawEvents.slice(0, 10), detectedTimezone)
      const sampleExpanded = expanded.slice(0, 10).map(e => ({
        summary: icalText(e.summary),
        start: e.start?.toISOString?.(),
        end: e.end?.toISOString?.(),
        uid: e.uid?.slice(0, 50),
      }))
      
      res.json({
        sourceId: source.id,
        sourceType: source.source_type,
        detectedTimezone,
        rawEventCount: rawEvents.length,
        expandedEventCount: expanded.length,
        sampleRawEvents: sampleEvents,
        sampleExpandedEvents: sampleExpanded,
      })
    } catch (error) {
      console.error('[/api/debug/source] failed:', error)
      res.status(500).json({
        error: { message: 'Debug failed.', status: 500 },
      })
    }
  })

  // Purdue schedule auto-capture (issue #120). The capture opens a visible
  // Chromium on the machine running the server, so it is a local-dev convenience
  // only: hidden in production (like /api/debug/source) and refused unless
  // PURDUE_CALENDAR_AUTOMATION is explicitly on, so /start never reaches
  // chromium.launch on a headless host such as Render.
  function requireCalendarAutomation(req, res, next) {
    if (isProduction) {
      return res.status(404).json({ error: { message: 'Not found.', status: 404 } })
    }
    if (!isCalendarAutomationEnabled()) {
      return res.status(409).json({
        error: {
          message: 'Purdue schedule auto-capture is disabled on this server. Paste your UniTime iCalendar URL instead.',
          status: 409,
        },
      })
    }
    next()
  }

  router.post('/api/purdue/calendar-link/start', requireAuth, requireCalendarAutomation, requirePurdueLinked, async (req, res) => {
    try {
      const job = await startCalendarCapture(req.currentUser.id)
      res.status(202).json({ job })
    } catch (error) {
      res.status(500).json({ error: { message: error.message || 'Could not start Purdue timetable automation.', status: 500 } })
    }
  })

  router.get('/api/purdue/calendar-link/status', requireAuth, requireCalendarAutomation, requirePurdueLinked, async (req, res) => {
    res.json({ job: getCalendarCaptureJob(req.currentUser.id) })
  })

  router.post('/api/purdue/calendar-link/cancel', requireAuth, requireCalendarAutomation, requirePurdueLinked, async (req, res) => {
    res.json({ job: await cancelCalendarCapture(req.currentUser.id) })
  })

  router.post('/api/sources/purdue/schedule', sourceSyncRateLimit, requireAuth, requirePurdueLinked, async (req, res) => {
    const userId = req.currentUser.id
    const { icsUrl, label } = req.body

    // Validate URL
    if (!icsUrl || typeof icsUrl !== 'string' || icsUrl.trim().length < 10) {
      return res.status(400).json({ error: { message: 'Please provide a valid calendar URL.', status: 400 } })
    }

    const trimmedUrl = icsUrl.trim()

    // Check for common URL issues
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
      return res.status(400).json({ error: { message: 'Calendar URL must start with http:// or https://', status: 400 } })
    }

    try {
      console.log(`[/api/sources/purdue/schedule] User ${userId} creating source...`)
      const source = await createScheduleSource(userId, { icsUrl: trimmedUrl, label })
      
      console.log(`[/api/sources/purdue/schedule] User ${userId} syncing source ${source.id}...`)
      const sync = await runScheduleSync(source)
      
      console.log(`[/api/sources/purdue/schedule] User ${userId} sync complete: ${sync.itemCount} items`)
      res.status(201).json({ source: await getSourceForUser(source.id, userId), sync })
    } catch (error) {
      console.error(`[/api/sources/purdue/schedule] User ${userId} error:`, error?.message || error)
      res.status(400).json({ error: { message: error.message || 'Could not connect the Purdue schedule source.', status: 400 } })
    }
  })

  router.post('/api/sources/brightspace/schedule', sourceSyncRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { icsUrl, label } = req.body

    // Validate URL
    if (!icsUrl || typeof icsUrl !== 'string' || icsUrl.trim().length < 10) {
      return res.status(400).json({ error: { message: 'Please provide a calendar URL.', status: 400 } })
    }

    const trimmedUrl = icsUrl.trim()

    // Check for common URL issues
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
      return res.status(400).json({ error: { message: 'Calendar URL must start with http:// or https://', status: 400 } })
    }

    try {
      console.log(`[/api/sources/brightspace/schedule] User ${userId} creating source...`)
      const source = await createScheduleSource(userId, { 
        icsUrl: trimmedUrl, 
        label: label || 'Brightspace Calendar',
        sourceType: 'brightspace_ical'
      })
      
      console.log(`[/api/sources/brightspace/schedule] User ${userId} syncing source ${source.id}...`)
      const sync = await runScheduleSync(source)
      
      console.log(`[/api/sources/brightspace/schedule] User ${userId} sync complete: ${sync.itemCount} items`)
      res.status(201).json({ source: await getSourceForUser(source.id, userId), sync })
    } catch (error) {
      console.error(`[/api/sources/brightspace/schedule] User ${userId} error:`, error?.message || error)
      res.status(400).json({ error: { message: error.message || 'Could not connect the Brightspace calendar.', status: 400 } })
    }
  })

  router.post('/api/sync/:sourceId', sourceSyncRateLimit, requireIdParam('sourceId'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const sourceId = req.params.sourceId
    
    const source = await getSourceForUser(sourceId, userId)
    if (!source) {
      return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
    }
    
    try {
      console.log(`[/api/sync] User ${userId} re-syncing source ${sourceId}...`)
      const sync = await runScheduleSync(source)
      console.log(`[/api/sync] User ${userId} sync complete: ${sync.itemCount} items`)
      
      const response = { source: await getSourceForUser(sourceId, userId), sync }
      
      // Include warning in response if some items were skipped
      if (sync.skippedCount > 0) {
        response.warning = `${sync.skippedCount} items had invalid dates and were skipped.`
      }
      
      res.json(response)
    } catch (error) {
      console.error(`[/api/sync] User ${userId} source ${sourceId} error:`, error?.message || error)
      res.status(400).json({ error: { message: error.message || 'Could not sync source.', status: 400 } })
    }
  })

  router.delete('/api/sources/:sourceId', userWriteRateLimit, requireIdParam('sourceId'), requireAuth, async (req, res) => {
    const source = await getSourceForUser(req.params.sourceId, req.currentUser.id)
    if (!source) {
      return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
    }
    try {
      // Delete all calendar items for this source
      await supabase
        .from('calendar_items')
        .delete()
        .eq('source_id', source.id)
      
      // Delete the source itself
      await supabase
        .from('linked_sources')
        .delete()
        .eq('id', source.id)

      onboardingSummaryCache.invalidate(req.currentUser.id)
      
      res.json({ ok: true, message: 'Source and all associated items deleted.' })
    } catch (error) {
      res.status(400).json({ error: { message: error.message || 'Could not delete source.', status: 400 } })
    }
  })

  // Background re-sync of linked calendar sources (issue #12): keeps imported
  // due dates fresh without the student pressing "Sync all". Called hourly by
  // the pg_cron job in db/supabase-source-resync.sql with the same bearer token
  // as the reminder runner. Sequential per run (one upstream fetch at a time),
  // 15 sources per tick, oldest first; a tick already in flight answers 409.
  // The candidate listing gets one retry on a transient Supabase failure, and
  // each feed fetch one retry on a transient failure of the feed host.
  let sourceResyncInFlight = false
  router.post('/api/internal/sources/resync', async (req, res, next) => {
    if (!PUSH_CRON_SECRET) return next()
    if (!pushCronSecretMatches(req.get('authorization'))) {
      return res.status(401).json({ error: { message: 'Invalid cron secret.', status: 401 } })
    }
    if (sourceResyncInFlight) {
      return res.status(409).json({ ok: false, error: 'resync_in_progress' })
    }
    sourceResyncInFlight = true
    try {
      const sync = (source) => runScheduleSync(source, { retryTransient: true })
      const outcome = await runCronTick('resync', () => runSourceResync({ client: supabase, sync }))
      if (outcome.ok) {
        const summary = outcome.summary
        if (summary.due) console.log(`[resync] ${JSON.stringify(summary)}`)
        return res.json(summary)
      }
      if (outcome.transient) {
        warnCronTransient('POST /api/internal/sources/resync', outcome.error)
        return res.status(503).json({ ok: false, error: 'Resync run skipped: upstream unavailable, the next tick will retry.' })
      }
      console.error('POST /api/internal/sources/resync:', outcome.error?.message || outcome.error)
      res.status(500).json({ ok: false, error: 'Resync run failed.' })
    } finally {
      sourceResyncInFlight = false
    }
  })

  return router
}
