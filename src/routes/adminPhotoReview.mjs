import express from 'express'
import { badRequest } from '../dbErrors.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { respondMarketplaceDbError } from '../marketplaceDb.mjs'
import { decidePhotoReview, listPendingPhotoReviews } from '../marketplacePhotoReview.mjs'

// The admin photo queue (issue #504): marketplace listings whose photos wait
// for an admin before other students see them, the longest waiting first.
// Approve shows the photos to everyone; reject clears them from the listing,
// which stays up without photos. Photos only wait while
// MARKETPLACE_PHOTO_REVIEW is on, but the queue works either way, so listings
// held before the switch went off can still be decided. Needs
// db/supabase-marketplace-photo-review.sql (README step 46); until it runs
// every route answers 503 photo_review_schema_missing.

// updated_at as the queue sent it, e.g. 2026-10-24T15:04:05.123456+00:00.
const MAX_VERSION_LENGTH = 64

function readVersion(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_VERSION_LENGTH || Number.isNaN(Date.parse(value))) return null
  return value
}

const DECISION_MESSAGES = {
  404: 'No listing with photos waiting for review.',
  409: 'The seller changed this listing after the queue loaded. Reload to see the latest photos.',
}

/**
 * The admin photo queue, mounted by server.mjs right after the admin report
 * queue. Every route runs requireAuth, then requireAdmin; the two writes run
 * the admin-write limiter first, then requireIdParam('id'), as the other admin
 * writes do.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase            the Supabase client
 * @param {Function} deps.requireAuth         loads req.currentUser or answers 401
 * @param {Function} deps.requireAdmin        answers 403 unless req.currentUser is an admin
 * @param {Function} deps.adminWriteRateLimit the `admin-write` limiter
 */
export function createAdminPhotoReviewRouter({ supabase, requireAuth, requireAdmin, adminWriteRateLimit }) {
  const router = express.Router()

  router.get('/api/admin/photo-review', requireAuth, requireAdmin, async (_req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
      res.json({ listings: await listPendingPhotoReviews(supabase) })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  })

  // Body: { updatedAt }, the listing's updatedAt from the queue. An edit since
  // then answers 409, so an admin never approves photos they did not see.
  const decide = (decision) => async (req, res) => {
    const updatedAt = readVersion(req.body?.updatedAt)
    if (!updatedAt) return badRequest(res, 'Reload the photo queue and try again.')
    try {
      const { status } = await decidePhotoReview(supabase, {
        listingId: req.params.id,
        decision,
        updatedAt,
        reviewerId: req.currentUser.id,
        now: new Date().toISOString(),
      })
      if (status !== 200) return res.status(status).json({ error: { message: DECISION_MESSAGES[status], status } })
      res.json({ ok: true, photosReview: decision })
    } catch (e) {
      return respondMarketplaceDbError(res, e)
    }
  }

  router.post('/api/admin/photo-review/:id/approve', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, decide('approved'))
  router.post('/api/admin/photo-review/:id/reject', adminWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, decide('rejected'))

  return router
}
