import crypto from 'node:crypto'
import express from 'express'
import { buildCalendarFeed } from '../icsFeed.mjs'

// The calendar feed (issue #48): a subscribable .ics of the user's aggregated
// calendar, the next six months of calendar items and the open manual tasks.
// A calendar app sends no cookie, so the token in the feed URL is the only
// credential: it must be a UUID v4, is never logged, and is regenerable
// (regenerating invalidates the old link). See db/supabase-calendar-feed.sql
// and docs/RATE_LIMITS.md. Moved out of server.mjs as a feature router (issue
// #191) with the handlers unchanged. It stays behind the session middleware,
// not among the session-free public reads (issue #250): the feed is per-user
// data, answered with a private Cache-Control.

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FEED_HORIZON_MONTHS = 6

/**
 * GET /api/me/calendar-feed and POST /api/me/calendar-feed/token, the
 * signed-in student's feed link, and GET /feeds/calendar/:file, the feed a
 * calendar app polls with the token in the URL, mounted by server.mjs where
 * they used to be, behind the session middleware. Paths stay absolute
 * (`/api/me/calendar-feed`) so docs/RATE_LIMITS.md and its guard test read
 * the same whether a route lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase              the Supabase client
 * @param {Function} deps.requireAuth           loads req.currentUser or answers 401
 * @param {string}   deps.publicBaseUrl         the backend's public origin (BACKEND_PUBLIC_URL) every feed link starts with
 * @param {Function} deps.calendarFeedRateLimit the per-address feed limiter: a calendar app has no session to key by
 * @param {Function} deps.userWriteRateLimit    the shared per-user write limiter (the token route)
 */
export function createCalendarFeedRouter({ supabase, requireAuth, publicBaseUrl, calendarFeedRateLimit, userWriteRateLimit }) {
  const router = express.Router()

  function feedUrlForToken(token) {
    return `${publicBaseUrl}/feeds/calendar/${token}.ics`
  }

  router.get('/api/me/calendar-feed', requireAuth, (req, res) => {
    const token = req.currentUser.calendar_feed_token
    res.json({ feedUrl: token ? feedUrlForToken(token) : null })
  })

  router.post('/api/me/calendar-feed/token', userWriteRateLimit, requireAuth, async (req, res) => {
    const token = crypto.randomUUID()
    const { error } = await supabase
      .from('users')
      .update({ calendar_feed_token: token })
      .eq('id', req.currentUser.id)
    if (error) {
      console.error('POST /api/me/calendar-feed/token:', error.message)
      return res.status(500).json({ error: { message: 'Could not generate a calendar feed link. Please try again.', status: 500 } })
    }
    res.json({ feedUrl: feedUrlForToken(token) })
  })

  router.get('/feeds/calendar/:file', calendarFeedRateLimit, async (req, res) => {
    const file = String(req.params.file || '')
    if (!file.toLowerCase().endsWith('.ics')) {
      return res.status(404).type('text/plain').send('Not found')
    }
    const token = file.slice(0, -'.ics'.length)
    if (!UUID_V4_RE.test(token)) {
      return res.status(404).type('text/plain').send('Not found')
    }

    // Look the user up by token only - never logged, never reflected back.
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id')
      .eq('calendar_feed_token', token)
      .maybeSingle()
    if (userErr || !user) {
      return res.status(404).type('text/plain').send('Not found')
    }

    const now = new Date()
    const horizon = new Date(now)
    horizon.setMonth(horizon.getMonth() + FEED_HORIZON_MONTHS)

    const [itemsRes, tasksRes] = await Promise.all([
      supabase
        .from('calendar_items')
        .select('id, title, description, start_time, end_time, location')
        .eq('user_id', user.id)
        .gte('start_time', now.toISOString())
        .lte('start_time', horizon.toISOString())
        .order('start_time', { ascending: true }),
      supabase
        .from('user_manual_tasks')
        .select('id, title, due_at')
        .eq('user_id', user.id)
        .is('completed_at', null)
        .order('due_at', { ascending: true }),
    ])

    if (itemsRes.error || tasksRes.error) {
      console.error('GET /feeds/calendar:', itemsRes.error?.message || tasksRes.error?.message)
      return res.status(500).type('text/plain').send('Calendar feed temporarily unavailable')
    }

    const events = []
    for (const row of itemsRes.data || []) {
      events.push({
        uid: row.id,
        summary: row.title || 'Untitled',
        description: row.description || undefined,
        location: row.location || undefined,
        start: new Date(row.start_time),
        end: row.end_time ? new Date(row.end_time) : undefined,
      })
    }
    for (const task of tasksRes.data || []) {
      events.push({
        uid: `manual-${task.id}`,
        summary: task.title || 'Task',
        start: new Date(task.due_at),
        allDay: true,
      })
    }

    const ics = buildCalendarFeed({ events, now })
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', 'inline; filename="boilerindy.ics"')
    res.setHeader('Cache-Control', 'private, max-age=900')
    res.send(ics)
  })

  return router
}
