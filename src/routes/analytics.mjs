import crypto from 'node:crypto'
import express from 'express'
import { normalizeAnalyticsBatch } from '../analytics.mjs'

// First-party product analytics (issue #51): POST /api/usage/events, the
// signed-in usage beacon. Signed-in students only; events live in our own
// Supabase (analytics_events, service-role only - see
// db/supabase-analytics.sql). The server re-checks the opt-out so a stale or
// misbehaving client can never record an opted-out user. Accepts
// navigator.sendBeacon flushes too (text/plain body), hence the manual JSON
// parse fallback. See docs/analytics.md. Moved out of server.mjs as a feature
// router (issue #191) with the handler unchanged apart from nowIso() and
// makeId() inlined.

/**
 * The usage beacon, mounted by server.mjs where the route used to be, behind
 * the session middleware. Paths stay absolute (`/api/usage/events`) so
 * docs/RATE_LIMITS.md and its guard test read the same whether a route lives
 * here or in server.mjs. express.text() stays on the route line, so only this
 * route accepts a text/plain body; a JSON body arrives already parsed by the
 * app-level express.json().
 *
 * @param {object}   deps
 * @param {object}   deps.supabase           the Supabase client
 * @param {Function} deps.requireAuth        loads req.currentUser or answers 401
 * @param {Function} deps.analyticsRateLimit the `analytics` limiter (60 per 5 minutes),
 *   ahead of requireAuth so a signed-out flood is metered too
 */
export function createAnalyticsRouter({ supabase, requireAuth, analyticsRateLimit }) {
  const router = express.Router()

  router.post('/api/usage/events', analyticsRateLimit, requireAuth, express.text({ type: 'text/plain' }), async (req, res) => {
    if (req.currentUser.analytics_opt_out) {
      return res.status(204).end()
    }

    let body = req.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        return res.status(400).json({ error: { message: 'Invalid analytics payload.', status: 400 } })
      }
    }

    let rows
    try {
      rows = normalizeAnalyticsBatch(body)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const timestamp = new Date().toISOString()
    const { error } = await supabase.from('analytics_events').insert(
      rows.map((row) => ({
        id: crypto.randomUUID(),
        user_id: req.currentUser.id,
        ...row,
        created_at: timestamp,
      })),
    )

    // Best-effort: analytics must never surface errors to students (e.g. table
    // not created yet). Log and accept.
    if (error) {
      console.error('[/api/usage/events] insert failed:', error?.message || error)
      return res.status(202).json({ ok: false })
    }
    res.status(204).end()
  })

  return router
}
