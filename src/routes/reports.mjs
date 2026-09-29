import express from 'express'
import { parseContentReport, REPORT_TARGETS } from '../contentReports.mjs'
import { badRequest, DB_FEATURES, respondDbError } from '../dbErrors.mjs'
import { recordListingReport } from '../marketplaceReports.mjs'
import { selectLiveRows } from '../moderation.mjs'

// Reporting content (issue #192): one route for every surface students post
// to. The target is looked up before anything is written, so a report of a
// deleted or unknown id is a 404 rather than a queue entry nobody can open,
// and nobody can report their own content. A marketplace listing goes through
// recordListingReport, which also counts it toward the automatic hide (#204).
// The answers never say who wrote the content, so reporting an anonymous board
// post reveals nothing about its author.

// The reported row, live rows only where the table soft-deletes (study groups
// read without the filter until their deleted_at migration runs).
function loadTarget(supabase, target, targetId) {
  const columns = target.authorColumn === 'id' ? 'id' : `id, ${target.authorColumn}`
  if (!target.softDelete) {
    return supabase.from(target.table).select(columns).eq('id', targetId).maybeSingle()
  }
  return selectLiveRows((liveOnly) => {
    let query = supabase.from(target.table).select(columns).eq('id', targetId)
    if (liveOnly) query = query.is('deleted_at', null)
    return query.maybeSingle()
  })
}

/**
 * The report route, mounted by server.mjs next to the layouts router.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase        the Supabase client
 * @param {Function} deps.requireAuth     loads req.currentUser or answers 401
 * @param {Function} deps.reportRateLimit the `report` limiter (20 an hour)
 */
export function createReportsRouter({ supabase, requireAuth, reportRateLimit }) {
  const router = express.Router()

  router.post('/api/reports', reportRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const parsed = parseContentReport(req.body || {})
    if (!parsed.ok) return badRequest(res, parsed.message)
    const { targetType, targetId, reason, details } = parsed.value
    if (targetType === 'user' && targetId === String(userId).toLowerCase()) {
      return badRequest(res, 'You cannot report yourself.')
    }
    const target = REPORT_TARGETS[targetType]
    try {
      const { data: row, error: lookupErr } = await loadTarget(supabase, target, targetId)
      if (lookupErr) throw lookupErr
      if (!row) return res.status(404).json({ error: { message: 'That content is no longer available.', status: 404 } })
      if (row[target.authorColumn] === userId) return badRequest(res, 'You cannot report your own content.')

      const now = new Date().toISOString()
      if (targetType === 'marketplace') {
        const { duplicate } = await recordListingReport(supabase, { listingId: targetId, reporterId: userId, reason, details, now })
        return res.json(duplicate ? { ok: true, duplicate: true } : { ok: true })
      }
      const { error } = await supabase.from('content_reports').insert({
        target_type: targetType,
        target_id: targetId,
        reporter_id: userId,
        reason,
        details,
        created_at: now,
      })
      // unique (target_type, target_id, reporter_id): one report per reporter
      // per target, and a second one is not an error.
      if (error?.code === '23505') return res.json({ ok: true, duplicate: true })
      if (error) throw error
      res.json({ ok: true })
    } catch (e) {
      return respondDbError(res, e, DB_FEATURES.content_reports)
    }
  })

  return router
}
