import express from 'express'
import { excludeBlocked, isBlockedEither, loadBlockedIds } from '../blocks.mjs'
import { assertBoardPostTextAllowed } from '../boardProfanity.mjs'
import { badRequest } from '../dbErrors.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { evaluateReportTarget, mapListingRow, parseReportParts, validateListingInput } from '../marketplace.mjs'
import { countMarketplaceReports, findOwnedMarketplaceListing, respondMarketplaceDbError } from '../marketplaceDb.mjs'
import { photoAuthorizationHandler } from '../marketplacePhotos.mjs'
import { recordListingReport } from '../marketplaceReports.mjs'
import { ownerOrAdminScope } from '../moderation.mjs'
import { sanitizeSearchTerm } from '../searchTerm.mjs'

// Student Marketplace (issue #32, Phase 1): listings and reports. Posting
// requires Purdue verification; 3 distinct reports auto-hide a listing.
// Requires db/supabase-marketplace.sql, db/supabase-marketplace-gallery-pricing.sql
// for photos and pricing, and db/supabase-soft-delete.sql for the deleted_at
// column. Moved out of server.mjs as a feature router (issue #191) with the
// handlers unchanged, except that the shared readers in src/marketplaceDb.mjs
// take the Supabase client as their first argument.

const MARKETPLACE_PAGE_SIZE = 24

/**
 * The marketplace routes, mounted by server.mjs where they used to be.
 * Paths stay absolute (`/api/marketplace`) so docs/RATE_LIMITS.md and its
 * guard test read the same whether a route lives here or in server.mjs.
 * `/mine` and `/capabilities` stay registered before `/:id`.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase                  the Supabase client
 * @param {Function} deps.requireAuth               loads req.currentUser or answers 401
 * @param {Function} deps.isUserAdmin               true for an admin: sees hidden listings, deletes any listing
 * @param {object}   deps.marketplacePhotos         createMarketplacePhotos(...) from server.mjs, which holds the secret
 * @param {Function} deps.marketplacePhotoRateLimit the photo upload limiter
 * @param {Function} deps.marketplaceReadRateLimit  the listing detail limiter (#114)
 * @param {Function} deps.boardWriteRateLimit       the community write limiter (create, edit, report)
 * @param {Function} deps.userWriteRateLimit        the shared per-user write limiter (delete)
 */
export function createMarketplaceRouter({ supabase, requireAuth, isUserAdmin, marketplacePhotos, marketplacePhotoRateLimit, marketplaceReadRateLimit, boardWriteRateLimit, userWriteRateLimit }) {
  const router = express.Router()

  router.post('/api/marketplace/photos/authorize', requireAuth, marketplacePhotoRateLimit,
    photoAuthorizationHandler({ photos: marketplacePhotos, findOwnedListing: (id, userId) => findOwnedMarketplaceListing(supabase, id, userId) }))

  // Browse active, non-hidden listings with optional category/text filter + paging.
  router.get('/api/marketplace', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : ''
    const q = typeof req.query.q === 'string' ? sanitizeSearchTerm(req.query.q) : ''
    const page = Math.max(0, parseInt(req.query.page, 10) || 0)
    try {
      const blocked = await loadBlockedIds(supabase, userId)
      let query = supabase
        .from('marketplace_listings')
        .select('*')
        .is('deleted_at', null)
        .eq('status', 'active')
        .eq('hidden', false)
        .order('created_at', { ascending: false })
        .range(page * MARKETPLACE_PAGE_SIZE, page * MARKETPLACE_PAGE_SIZE + MARKETPLACE_PAGE_SIZE - 1)
      if (category) query = query.eq('category', category)
      if (q) query = query.ilike('title', `%${q}%`)
      // Users on either side of a block with the caller are left out in the
      // query, so hasMore stays exact (#192).
      query = excludeBlocked(query, 'user_id', blocked)
      const { data, error } = await query
      if (error) throw error
      res.json({
        listings: (data || []).map((r) => mapListingRow(r, userId)),
        page,
        hasMore: (data || []).length === MARKETPLACE_PAGE_SIZE,
        canPost: Boolean(req.currentUser.purdue_linked_at),
      })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  // The current user's own listings (any status).
  router.get('/api/marketplace/mine', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const { data, error } = await supabase
        .from('marketplace_listings')
        .select('*')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
      if (error) throw error
      const listings = data || []
      // Only hidden rows carry a count: it explains why the listing went dark.
      // A live listing's running total is moderation data and stays server-side.
      const reports = await countMarketplaceReports(supabase, listings.filter((r) => r.hidden).map((r) => r.id))
      res.json({
        listings: listings.map((r) => mapListingRow(r, userId, null, { reportCount: reports.get(r.id)?.count })),
      })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  // Clients check this before uploading a gallery to avoid older servers dropping fields.
  router.get('/api/marketplace/capabilities', requireAuth, async (_req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
      const { error } = await supabase.from('marketplace_listings').select('image_urls,price_mode').limit(0)
      if (error) throw error
      res.json({ gallery: true, pricing: true, maxPhotos: 6 })
    } catch {
      res.status(503).json({ error: { message: 'Marketplace photo and pricing setup is not complete. Please try again later.', status: 503 } })
    }
  })

  // Listing detail - reveals seller contact (name + Purdue email) to signed-in
  // users, so it is rate-limited to blunt bulk id-enumeration harvesting (#114).
  router.get('/api/marketplace/:id', marketplaceReadRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const { data, error } = await supabase.from('marketplace_listings').select('*').eq('id', req.params.id).is('deleted_at', null).maybeSingle()
      if (error) throw error
      if (
        !data
        || (data.hidden && data.user_id !== userId && !isUserAdmin(req.currentUser))
        // A block either way reads as a missing listing (#192).
        || isBlockedEither(await loadBlockedIds(supabase, userId), data.user_id)
      ) {
        return res.status(404).json({ error: { message: 'Listing not found.', status: 404 } })
      }
      const { data: seller } = await supabase.from('users').select('display_name, email').eq('id', data.user_id).single()
      res.json({ listing: mapListingRow(data, userId, { name: seller?.display_name, email: seller?.email }) })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  // Create - requires Purdue verification.
  router.post('/api/marketplace', boardWriteRateLimit, requireAuth, async (req, res) => {
    if (!req.currentUser.purdue_linked_at) {
      return res.status(403).json({ error: { message: 'Link your Purdue account in setup before posting.', status: 403 } })
    }
    const { value, error: invalid } = validateListingInput(req.body || {}, { partial: false })
    if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })
    const profanity = assertBoardPostTextAllowed(value.title, value.description)
    if (!profanity.ok) return res.status(400).json({ error: { message: profanity.message, status: 400 } })
    try {
      Object.assign(value, await marketplacePhotos.resolve(req.body || {}, req.currentUser.id))
      const { data, error } = await supabase
        .from('marketplace_listings')
        .insert({ user_id: req.currentUser.id, ...value })
        .select('*')
        .single()
      if (error) throw error
      res.status(201).json({ listing: mapListingRow(data, req.currentUser.id) })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  // Edit / mark sold - owner only.
  router.patch('/api/marketplace/:id', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { value, error: invalid } = validateListingInput(req.body || {}, { partial: true })
    if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })
    if (Object.keys(value).length === 0 && req.body?.imageUploadReceipt === undefined && req.body?.photos === undefined) {
      return res.status(400).json({ error: { message: 'No valid fields to update.', status: 400 } })
    }
    if (value.title || value.description) {
      const profanity = assertBoardPostTextAllowed(value.title || '', value.description || '')
      if (!profanity.ok) return res.status(400).json({ error: { message: profanity.message, status: 400 } })
    }
    try {
      const current = await findOwnedMarketplaceListing(supabase, req.params.id, userId)
      if (!current) return res.status(404).json({ error: { message: 'Listing not found or not yours.', status: 404 } })
      Object.assign(value, await marketplacePhotos.resolve(req.body || {}, userId, req.params.id, current.image_url, current.image_urls))
      const { data, error } = await supabase
        .from('marketplace_listings')
        .update({ ...value, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .select('*')
      if (error) throw error
      if (!data?.length) return res.status(404).json({ error: { message: 'Listing not found or not yours.', status: 404 } })
      res.json({ listing: mapListingRow(data[0], userId) })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  // Delete - owner or admin.
  router.delete('/api/marketplace/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      // Soft delete: hide the listing (set deleted_at). Admins purge it
      // permanently from the moderation view.
      const query = supabase
        .from('marketplace_listings')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .is('deleted_at', null)
      const { data, error } = await ownerOrAdminScope(query, { userId, isAdmin: isUserAdmin(req.currentUser) }).select('id')
      if (error) throw error
      if (!data?.length) return res.status(404).json({ error: { message: 'Listing not found or not yours.', status: 404 } })
      res.status(204).end()
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  // Report a listing; auto-hide at REPORTS_TO_HIDE distinct reporters. The
  // listing is looked up before the insert (issue #204): until then a report
  // against a soft-deleted or unknown id reached the foreign key and came back
  // as a 500, and nothing stopped a seller reporting their own listing.
  // recordListingReport also files the report in the admin queue (#192), the
  // same write POST /api/reports makes for a listing.
  router.post('/api/marketplace/:id/report', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const listingId = req.params.id
    const parsed = parseReportParts(req.body || {})
    if (!parsed.ok) return badRequest(res, parsed.message)
    try {
      const { data: listing, error: lookupErr } = await supabase
        .from('marketplace_listings')
        .select('id, user_id, hidden')
        .eq('id', listingId)
        .is('deleted_at', null)
        .maybeSingle()
      if (lookupErr) throw lookupErr
      const verdict = evaluateReportTarget({ listing, reporterId: userId })
      if (verdict.status === 404) {
        return res.status(404).json({ error: { message: verdict.message, status: 404 } })
      }
      if (verdict.status !== 200) return badRequest(res, verdict.message)

      const { duplicate } = await recordListingReport(supabase, {
        listingId,
        reporterId: userId,
        reason: parsed.reason,
        details: parsed.details,
        now: new Date().toISOString(),
      })
      if (duplicate) return res.json({ ok: true, duplicate: true })
      res.json({ ok: true })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  return router
}
