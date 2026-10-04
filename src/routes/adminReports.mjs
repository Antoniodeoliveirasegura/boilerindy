import express from 'express'
import { REPORT_STATUSES, REPORT_TARGETS } from '../contentReports.mjs'
import { badRequest, DB_FEATURES, isSchemaMissingError, respondDbError } from '../dbErrors.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { isMissingColumnError } from '../moderation.mjs'

// The admin report queue (issue #192): every open report on student content,
// newest first, with enough of the reported thing to act on it. Taking content
// down stays with each type's own DELETE route (and the hidden-listing
// takedown), so this router only lists reports and closes them.

const QUEUE_LIMIT = 200
// Same code as POST /api/reports, a message that fits a read.
const ADMIN_REPORTS_DB = { ...DB_FEATURES.content_reports, fallback: 'Could not load the reports. Please try again.' }

// The columns to read for one target type: its title, its author and, where
// the table has them, deleted_at and the marketplace hidden flag.
function targetColumns(type, target, { withDeletedAt }) {
  const columns = new Set(['id', target.titleColumn, target.authorColumn])
  if (target.softDelete && withDeletedAt) columns.add('deleted_at')
  if (type === 'marketplace') columns.add('hidden')
  return [...columns].join(', ')
}

// One query per target type present in the page of reports. A table that is not
// installed yet reads as no targets; study groups before their deleted_at
// migration are read without that column.
async function loadTargets(supabase, reports) {
  const idsByType = new Map()
  for (const report of reports) {
    if (!Object.prototype.hasOwnProperty.call(REPORT_TARGETS, report.target_type)) continue
    if (!idsByType.has(report.target_type)) idsByType.set(report.target_type, new Set())
    idsByType.get(report.target_type).add(report.target_id)
  }
  const rows = new Map()
  for (const [type, ids] of idsByType) {
    const target = REPORT_TARGETS[type]
    const read = (withDeletedAt) =>
      supabase.from(target.table).select(targetColumns(type, target, { withDeletedAt })).in('id', [...ids])
    let { data, error } = await read(true)
    if (error && target.softDelete && isMissingColumnError(error, 'deleted_at')) ({ data, error } = await read(false))
    if (error && isSchemaMissingError(error)) continue
    if (error) throw error
    for (const row of data || []) rows.set(`${type}:${row.id}`, row)
  }
  return rows
}

/**
 * The admin report queue, mounted by server.mjs right after the admin router.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase            the Supabase client
 * @param {Function} deps.requireAuth         loads req.currentUser or answers 401
 * @param {Function} deps.requireAdmin        answers 403 unless req.currentUser is an admin
 * @param {Function} deps.adminWriteRateLimit the `admin-write` limiter
 */
export function createAdminReportsRouter({ supabase, requireAuth, requireAdmin, adminWriteRateLimit }) {
  const router = express.Router()

  router.get('/api/admin/reports', requireAuth, requireAdmin, async (req, res) => {
    const status = req.query.status === undefined || req.query.status === '' ? 'open' : String(req.query.status)
    if (!REPORT_STATUSES.includes(status)) return badRequest(res, 'Status must be open, resolved or dismissed.')
    try {
      const { data, error } = await supabase
        .from('content_reports')
        .select('*')
        .eq('status', status)
        .order('created_at', { ascending: false })
        .limit(QUEUE_LIMIT)
      if (error) throw error
      const reports = data || []
      const targets = await loadTargets(supabase, reports)

      // One users lookup names every reporter and every author on the page.
      const userIds = new Set(reports.map((r) => r.reporter_id))
      for (const report of reports) {
        const row = targets.get(`${report.target_type}:${report.target_id}`)
        const authorId = row?.[REPORT_TARGETS[report.target_type].authorColumn]
        if (authorId) userIds.add(authorId)
      }
      const names = new Map()
      if (userIds.size) {
        const { data: users, error: usersErr } = await supabase.from('users').select('id, display_name').in('id', [...userIds])
        if (usersErr) throw usersErr
        for (const u of users || []) names.set(u.id, u.display_name || null)
      }

      res.json({
        reports: reports.map((report) => {
          const config = REPORT_TARGETS[report.target_type]
          const row = config ? targets.get(`${report.target_type}:${report.target_id}`) : null
          const authorId = row ? row[config.authorColumn] ?? null : null
          return {
            id: report.id,
            targetType: report.target_type,
            targetId: report.target_id,
            reason: report.reason,
            details: report.details || '',
            status: report.status,
            createdAt: report.created_at,
            reporter: { id: report.reporter_id, displayName: names.get(report.reporter_id) ?? null },
            target: row
              ? {
                  title: row[config.titleColumn] ?? '',
                  authorId,
                  authorName: authorId ? names.get(authorId) ?? null : null,
                  deleted: Boolean(row.deleted_at),
                  hidden: Boolean(row.hidden),
                }
              : null,
          }
        }),
      })
    } catch (e) {
      return respondDbError(res, e, ADMIN_REPORTS_DB)
    }
  })

  router.patch('/api/admin/reports/:id', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    const status = String(req.body?.status ?? '')
    if (status !== 'resolved' && status !== 'dismissed') return badRequest(res, 'Status must be resolved or dismissed.')
    try {
      const { data, error } = await supabase
        .from('content_reports')
        .update({ status, resolved_at: new Date().toISOString(), resolved_by: req.currentUser.id })
        .eq('id', req.params.id)
        .eq('status', 'open')
        .select('id')
      if (error) throw error
      if (!data?.length) return res.status(404).json({ error: { message: 'No open report with that id.', status: 404 } })
      res.json({ ok: true, status })
    } catch (e) {
      return respondDbError(res, e, ADMIN_REPORTS_DB)
    }
  })

  return router
}
