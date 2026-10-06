import crypto from 'node:crypto'
import express from 'express'
import {
  LEAD_STATUSES,
  mapLeadRow,
  mapAdminAdvertiserRow,
  mapAdminCampaignRow,
  normalizeLeadStatusInput,
  normalizeAdminCampaignStatusInput,
  parseAdminListFilter,
} from '../adminPortal.mjs'
import { normalizeAdvertiserAccountInput } from '../advertiserAuth.mjs'
import { CAMPAIGN_STATUSES } from '../advertiserCampaign.mjs'
import { DB_FEATURES, respondDbError, respondSchemaMissing, SOFT_DELETE_SQL_FILE } from '../dbErrors.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { countMarketplaceReports, respondMarketplaceDbError } from '../marketplaceDb.mjs'
import { isMissingColumnError, isUuid } from '../moderation.mjs'
import { hashPassword } from '../passwordHash.mjs'
import { STUDY_SOFT_DELETE_SQL_FILE } from '../studyGroups.mjs'

// Platform admin (student session + isAdmin / ADMIN_EMAILS): the advertiser
// portal overview, leads, campaigns and accounts, the Purdue link release,
// soft-delete moderation (issue #195), the hidden-listing queue (issue #204)
// and the Sentry smoke test (issue #50). Moved out of server.mjs as a feature
// router (issue #191) with the handlers unchanged apart from nowIso() and
// makeId() inlined. The admin report queue (issue #192) is its own router,
// src/routes/adminReports.mjs, which server.mjs mounts right after this one;
// no path matches in both.

// 503 advertiser_schema_missing until the advertiser portal tables exist, 500
// otherwise: the same wrapper over src/dbErrors.mjs (#218) as the advertiser
// routes use, copied rather than shared because every router owns its
// respondXDbError.
function respondAdvertiserDbError(res, err) {
  return respondDbError(res, err, DB_FEATURES.advertiser)
}

// ── Soft-delete moderation (admin) ───────────────────────────────────────────
// User/owner delete endpoints only soft-delete (set deleted_at). Admins review
// hidden content here and either restore it or permanently (hard) delete it -
// this is the only hard-delete path. `type` is whitelisted so the param can
// never reach an arbitrary table.
// Study groups joined in issue #195; their public DELETE is creator-or-admin.
const SOFT_DELETE_TABLES = {
  board: { table: 'board_posts', label: 'Board post', sqlFile: SOFT_DELETE_SQL_FILE },
  marketplace: { table: 'marketplace_listings', label: 'Marketplace listing', sqlFile: SOFT_DELETE_SQL_FILE },
  'lost-found': { table: 'lost_found_items', label: 'Lost & Found item', sqlFile: SOFT_DELETE_SQL_FILE },
  guide: { table: 'guide_recommendations', label: 'Guide recommendation', sqlFile: SOFT_DELETE_SQL_FILE },
  deals: { table: 'deals', label: 'Deal', sqlFile: SOFT_DELETE_SQL_FILE },
  'study-groups': { table: 'study_groups', label: 'Study group', sqlFile: STUDY_SOFT_DELETE_SQL_FILE },
}

function softDeleteConfig(type) {
  return Object.prototype.hasOwnProperty.call(SOFT_DELETE_TABLES, type) ? SOFT_DELETE_TABLES[type] : null
}

// A table without deleted_at yet (study groups before their migration) fails
// every moderation query on the missing column: answer 503
// moderation_schema_missing (the log names the file to run) instead of a 500.
function respondModerationDbError(res, error, cfg, logLabel, message) {
  if (isMissingColumnError(error, 'deleted_at')) {
    return respondSchemaMissing(
      res,
      { ...DB_FEATURES.moderation, label: `${cfg.label} moderation`, sqlFile: cfg.sqlFile },
      error,
    )
  }
  // logLabel carries req.params.type, so it must not sit in console.error's
  // format-string slot: a `%s` in the value would consume error.message
  // (CodeQL js/tainted-format-string). A literal format keeps the same output.
  console.error('%s:', logLabel, error.message)
  return res.status(500).json({ error: { message, status: 500 } })
}

/**
 * The platform admin routes, mounted by server.mjs at the old section banner,
 * just above the admin report queue. Paths stay absolute (`/api/admin/leads`)
 * so docs/RATE_LIMITS.md and its guard test read the same whether a route
 * lives here or in server.mjs. Every route runs requireAuth, then
 * requireAdmin. A write runs the admin-write limiter first, then
 * requireIdParam('id') where it has an :id, as the content read does. The
 * Sentry smoke test hands its error to next(), which still reaches
 * Sentry.setupExpressErrorHandler and the final error handler, both
 * registered in server.mjs after every router.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase              the Supabase client
 * @param {Function} deps.requireAuth           loads req.currentUser or answers 401
 * @param {Function} deps.requireAdmin          answers 403 unless req.currentUser is an admin
 * @param {Function} deps.adminWriteRateLimit   the `admin-write` limiter
 * @param {Function} deps.normalizeEmail        trims and lowercases an address (src/userFields.mjs)
 * @param {Function} deps.clearPurdueLinkOnUser clears a user's Purdue link columns (src/purdueIdentity.mjs)
 */
export function createAdminRouter({ supabase, requireAuth, requireAdmin, adminWriteRateLimit, normalizeEmail, clearPurdueLinkOnUser }) {
  const router = express.Router()

  async function countTableRows(table, filters = []) {
    let query = supabase.from(table).select('*', { count: 'exact', head: true })
    for (const [column, value] of filters) {
      query = query.eq(column, value)
    }
    const { count, error } = await query
    if (error) throw error
    return count || 0
  }

  router.get('/api/admin/overview', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const [newLeads, pendingCampaigns, activeCampaigns, advertisers] = await Promise.all([
        countTableRows('advertiser_leads', [['status', 'new']]),
        countTableRows('campaigns', [['status', 'pending_review']]),
        countTableRows('campaigns', [['status', 'active']]),
        countTableRows('advertisers'),
      ])
      res.json({
        overview: {
          newLeads,
          pendingCampaigns,
          activeCampaigns,
          advertisers,
        },
      })
    } catch (error) {
      return respondAdvertiserDbError(res, error)
    }
  })

  router.get('/api/admin/leads', requireAuth, requireAdmin, async (req, res) => {
    let statusFilter
    try {
      statusFilter = parseAdminListFilter(req.query.status, LEAD_STATUSES)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    let query = supabase
      .from('advertiser_leads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (statusFilter) query = query.eq('status', statusFilter)

    const { data, error } = await query
    if (error) return respondAdvertiserDbError(res, error)
    res.json({ leads: (data || []).map(mapLeadRow) })
  })

  router.patch('/api/admin/leads/:id', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    let status
    try {
      status = normalizeLeadStatusInput(req.body?.status)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const { data, error } = await supabase
      .from('advertiser_leads')
      .update({ status })
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle()
    if (error) return respondAdvertiserDbError(res, error)
    if (!data) {
      return res.status(404).json({ error: { message: 'Lead not found.', status: 404 } })
    }
    res.json({ lead: mapLeadRow(data) })
  })

  router.get('/api/admin/campaigns', requireAuth, requireAdmin, async (req, res) => {
    let statusFilter
    try {
      statusFilter = parseAdminListFilter(req.query.status, CAMPAIGN_STATUSES)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    let query = supabase
      .from('campaigns')
      .select('*, advertisers ( email, company_name )')
      .order('created_at', { ascending: false })
      .limit(200)
    if (statusFilter) query = query.eq('status', statusFilter)

    const { data, error } = await query
    if (error) return respondAdvertiserDbError(res, error)
    res.json({ campaigns: (data || []).map(mapAdminCampaignRow) })
  })

  router.patch('/api/admin/campaigns/:id', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    const { data: current, error: lookupError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle()
    if (lookupError) return respondAdvertiserDbError(res, lookupError)
    if (!current) {
      return res.status(404).json({ error: { message: 'Campaign not found.', status: 404 } })
    }

    let status
    try {
      status = normalizeAdminCampaignStatusInput(current.status, req.body?.status)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const { data, error } = await supabase
      .from('campaigns')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', current.id)
      .select('*, advertisers ( email, company_name )')
      .single()
    if (error) return respondAdvertiserDbError(res, error)
    res.json({ campaign: mapAdminCampaignRow(data) })
  })

  router.get('/api/admin/advertisers', requireAuth, requireAdmin, async (_req, res) => {
    const { data, error } = await supabase
      .from('advertisers')
      .select('id, email, company_name, contact_name, status, created_at')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) return respondAdvertiserDbError(res, error)
    res.json({ advertisers: (data || []).map(mapAdminAdvertiserRow) })
  })

  router.post('/api/admin/advertisers', adminWriteRateLimit, requireAuth, requireAdmin, async (req, res) => {
    let account
    try {
      account = normalizeAdvertiserAccountInput(req.body)
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, status: 400 } })
    }

    const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId.trim() : ''
    const passwordHash = hashPassword(account.password)
    const timestamp = new Date().toISOString()

    const { data: existing } = await supabase
      .from('advertisers')
      .select('id')
      .eq('email', account.email)
      .maybeSingle()

    let row
    if (existing?.id) {
      const { data, error } = await supabase
        .from('advertisers')
        .update({
          password_hash: passwordHash,
          company_name: account.companyName,
          contact_name: account.contactName,
          status: 'active',
          updated_at: timestamp,
        })
        .eq('id', existing.id)
        .select('id, email, company_name, contact_name, status, created_at')
        .single()
      if (error) return respondAdvertiserDbError(res, error)
      row = data
    } else {
      const { data, error } = await supabase
        .from('advertisers')
        .insert({
          id: crypto.randomUUID(),
          email: account.email,
          password_hash: passwordHash,
          company_name: account.companyName,
          contact_name: account.contactName,
          status: 'active',
          created_at: timestamp,
          updated_at: timestamp,
        })
        .select('id, email, company_name, contact_name, status, created_at')
        .single()
      if (error) return respondAdvertiserDbError(res, error)
      row = data
    }

    if (leadId) {
      await supabase
        .from('advertiser_leads')
        .update({ status: 'closed' })
        .eq('id', leadId)
        .eq('email', account.email)
    }

    res.status(existing?.id ? 200 : 201).json({ advertiser: mapAdminAdvertiserRow(row) })
  })

  // Release a stale Purdue link (e.g. after account reset). Body: { purdueEmail } or { userId }.
  router.post('/api/admin/purdue-links/clear', adminWriteRateLimit, requireAuth, requireAdmin, async (req, res) => {
    const purdueEmail = normalizeEmail(req.body?.purdueEmail || '')
    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''

    if (!purdueEmail && !userId) {
      return res.status(400).json({
        error: { message: 'Provide purdueEmail or userId to clear a Purdue link.', status: 400 },
      })
    }

    let query = supabase.from('users').select('id, email, purdue_email')
    if (userId) query = query.eq('id', userId)
    else query = query.eq('purdue_email', purdueEmail)

    const { data: rows, error: lookupError } = await query
    if (lookupError) {
      console.error('[admin/purdue-links/clear] lookup failed:', lookupError.message)
      return res.status(500).json({ error: { message: 'Could not look up the user.', status: 500 } })
    }
    if (!rows?.length) {
      return res.status(404).json({ error: { message: 'No matching user profile found.', status: 404 } })
    }

    const cleared = []
    for (const row of rows) {
      if (!row.purdue_email) continue
      await clearPurdueLinkOnUser(row.id)
      cleared.push({ id: row.id, email: row.email, purdueEmail: row.purdue_email })
    }

    if (!cleared.length) {
      return res.status(404).json({ error: { message: 'Profile has no Purdue link to clear.', status: 404 } })
    }

    res.json({ ok: true, cleared })
  })

  router.get('/api/admin/deleted/:type', requireAuth, requireAdmin, async (req, res) => {
    const cfg = softDeleteConfig(req.params.type)
    if (!cfg) return res.status(404).json({ error: { message: 'Unknown content type.', status: 404 } })
    const { data, error } = await supabase
      .from(cfg.table)
      .select('*')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(200)
    if (error) {
      return respondModerationDbError(res, error, cfg, `GET /api/admin/deleted/${req.params.type}`, 'Could not load deleted items.')
    }
    res.json({ items: data || [], label: cfg.label })
  })

  // Live-content lookup for the takedown panel (issue #195): an admin pastes an
  // id from a report and previews the row here, then removes it through the
  // type's own DELETE route, which lets admins past the owner filter. The row
  // then shows up in the deleted list above, where it can be restored.
  router.get('/api/admin/content/:type/:id', requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    const cfg = softDeleteConfig(req.params.type)
    if (!cfg) return res.status(404).json({ error: { message: 'Unknown content type.', status: 404 } })
    if (!isUuid(req.params.id)) return res.status(404).json({ error: { message: 'Item not found.', status: 404 } })
    const { data, error } = await supabase
      .from(cfg.table)
      .select('*')
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) {
      return respondModerationDbError(res, error, cfg, `GET /api/admin/content/${req.params.type}`, 'Could not load the item.')
    }
    if (!data) return res.status(404).json({ error: { message: 'Item not found.', status: 404 } })
    res.json({ item: data, label: cfg.label })
  })

  router.post('/api/admin/deleted/:type/:id/restore', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    const cfg = softDeleteConfig(req.params.type)
    if (!cfg) return res.status(404).json({ error: { message: 'Unknown content type.', status: 404 } })
    const { data, error } = await supabase
      .from(cfg.table)
      .update({ deleted_at: null })
      .eq('id', req.params.id)
      .not('deleted_at', 'is', null)
      .select('id')
    if (error) {
      return respondModerationDbError(res, error, cfg, `restore ${req.params.type}`, 'Could not restore the item.')
    }
    if (!data?.length) return res.status(404).json({ error: { message: 'Item not found.', status: 404 } })
    res.json({ ok: true })
  })

  router.delete('/api/admin/deleted/:type/:id', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    const cfg = softDeleteConfig(req.params.type)
    if (!cfg) return res.status(404).json({ error: { message: 'Unknown content type.', status: 404 } })
    // Hard delete - permanent. Only already-soft-deleted rows can be purged, so a
    // mistyped call can never wipe live content. (Board posts cascade to replies.)
    const { data, error } = await supabase
      .from(cfg.table)
      .delete()
      .eq('id', req.params.id)
      .not('deleted_at', 'is', null)
      .select('id')
    if (error) {
      return respondModerationDbError(res, error, cfg, `hard delete ${req.params.type}`, 'Could not permanently delete the item.')
    }
    if (!data?.length) return res.status(404).json({ error: { message: 'Item not found.', status: 404 } })
    res.status(204).end()
  })

  // Hidden-listing moderation (admin, issue #204). REPORTS_TO_HIDE distinct
  // reports hide a marketplace listing on their own, and nothing could clear the
  // flag again: the owner never saw it and no admin route touched `hidden`, so
  // three accounts could bury any listing permanently. Admins work the queue
  // here. Marketplace is the only surface with an auto-hide, so these routes name
  // it rather than taking a :type; #192 generalises reports later.
  router.get('/api/admin/hidden/marketplace', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const { data, error } = await supabase
        .from('marketplace_listings')
        .select('*')
        .eq('hidden', true)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      const listings = data || []
      const reports = await countMarketplaceReports(supabase, listings.map((r) => r.id))
      res.json({
        items: listings.map((row) => ({
          ...row,
          reportCount: reports.get(row.id)?.count || 0,
          reasons: reports.get(row.id)?.reasons || [],
        })),
        label: 'Marketplace listing',
      })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  router.post('/api/admin/hidden/marketplace/:id/unhide', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('marketplace_listings')
        .update({ hidden: false })
        .eq('id', req.params.id)
        .eq('hidden', true)
        .select('id')
      if (error) throw error
      if (!data?.length) return res.status(404).json({ error: { message: 'Listing not found.', status: 404 } })
      // The reports go with it. Left in place the listing sits on the threshold
      // and the next single report hides it again, which undoes the decision
      // without any new account having to agree with the first three.
      const { error: clearErr } = await supabase.from('marketplace_reports').delete().eq('listing_id', req.params.id)
      if (clearErr) throw clearErr
      res.json({ ok: true })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  // Soft delete, so the listing lands in the deleted list above and an admin can
  // still restore it. Any live listing is fair game, not just a hidden one: the
  // button is in the hidden queue, but refusing a listing another admin un-hid a
  // second earlier would be a worse answer than doing the obvious thing.
  router.post('/api/admin/hidden/marketplace/:id/takedown', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('marketplace_listings')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .select('id')
      if (error) throw error
      if (!data?.length) return res.status(404).json({ error: { message: 'Listing not found.', status: 404 } })
      res.json({ ok: true })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  // Sentry smoke test (issue #50). Proves the backend error path end to end
  // without editing code: passing the error to next() runs it through
  // Sentry.setupExpressErrorHandler and the final safety net below, exactly the
  // route a real escaped exception takes, and the client gets the generic 500.
  // Admin-only, and only with ?confirm=1 so an idle browser tab cannot raise it.
  // With no SENTRY_DSN it just demonstrates the 500 shape. See docs/error-tracking.md.
  router.get('/api/admin/sentry-test', requireAuth, requireAdmin, (req, res, next) => {
    if (req.query.confirm !== '1') {
      return res.status(400).json({ error: { message: 'Add ?confirm=1 to raise a test error.', status: 400 } })
    }
    next(new Error(`Sentry smoke test raised via GET /api/admin/sentry-test at ${new Date().toISOString()}`))
  })

  return router
}
