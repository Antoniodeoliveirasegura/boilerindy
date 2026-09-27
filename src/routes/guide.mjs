import express from 'express'
import { excludeAuthors, loadBlockedIds } from '../blocks.mjs'
import { assertBoardPostTextAllowed } from '../boardProfanity.mjs'
import { DB_FEATURES, respondSoftDeleteFeatureDbError } from '../dbErrors.mjs'
import { mapGuideRow, validateGuideInput } from '../guideRecommendations.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { ownerOrAdminScope } from '../moderation.mjs'
import { toggleUpvote } from '../upvoteToggle.mjs'

// Neighborhood Guide (issue #31): student-submitted local recommendations.
// Reuses the board conventions: boardWriteRateLimit, the profanity policy and
// the upvote toggle. Requires db/supabase-neighborhood-guide.sql, and
// db/supabase-soft-delete.sql for the deleted_at column. Moved out of
// server.mjs as a feature router (issue #191) with the handlers unchanged.

function respondGuideDbError(res, err) {
  return respondSoftDeleteFeatureDbError(res, err, DB_FEATURES.guide)
}

/**
 * The Neighborhood Guide routes, mounted by server.mjs where they used to be.
 * Paths stay absolute (`/api/guide`) so docs/RATE_LIMITS.md and its guard
 * test read the same whether a route lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase            the Supabase client
 * @param {Function} deps.requireAuth         loads req.currentUser or answers 401
 * @param {Function} deps.requireAdmin        answers 403 unless req.currentUser is an admin
 * @param {Function} deps.isUserAdmin         true for an admin: lets the delete past the owner filter
 * @param {object}   deps.communityCounters   createCommunityCounters(supabase): the upvote recount
 * @param {Function} deps.boardWriteRateLimit the community write limiter (create, upvote)
 * @param {Function} deps.userWriteRateLimit  the shared per-user write limiter (pin, delete)
 */
export function createGuideRouter({ supabase, requireAuth, requireAdmin, isUserAdmin, communityCounters, boardWriteRateLimit, userWriteRateLimit }) {
  const router = express.Router()

  router.get('/api/guide', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : ''
    try {
      const blocked = await loadBlockedIds(supabase, userId)
      let query = supabase
        .from('guide_recommendations')
        .select('*')
        .is('deleted_at', null)
        .order('pinned', { ascending: false })
        .order('upvote_count', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(200)
      if (category) query = query.eq('category', category)
      // Users on either side of a block with the caller are left out (#192).
      query = excludeAuthors(query, 'user_id', blocked)
      const { data, error } = await query
      if (error) throw error

      const recs = data || []
      let upvoted = new Set()
      if (recs.length) {
        const { data: votes } = await supabase
          .from('guide_upvotes')
          .select('rec_id')
          .eq('user_id', userId)
          .in('rec_id', recs.map((r) => r.id))
        upvoted = new Set((votes || []).map((v) => v.rec_id))
      }
      res.json({ recommendations: recs.map((r) => mapGuideRow(r, userId, upvoted)) })
    } catch (e) {
      return respondGuideDbError(res, e)
    }
  })

  router.post('/api/guide', boardWriteRateLimit, requireAuth, async (req, res) => {
    const { value, error: invalid } = validateGuideInput(req.body || {})
    if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })

    const profanity = assertBoardPostTextAllowed(value.title, value.body)
    if (!profanity.ok) return res.status(400).json({ error: { message: profanity.message, status: 400 } })

    try {
      const { data, error } = await supabase
        .from('guide_recommendations')
        .insert({ user_id: req.currentUser.id, ...value })
        .select('*')
        .single()
      if (error) throw error
      res.status(201).json({ recommendation: mapGuideRow(data, req.currentUser.id) })
    } catch (e) {
      return respondGuideDbError(res, e)
    }
  })

  router.post('/api/guide/:id/upvote', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const recId = req.params.id
    const userId = req.currentUser.id
    try {
      const { data: rec, error: recErr } = await supabase
        .from('guide_recommendations')
        .select('id')
        .eq('id', recId)
        .is('deleted_at', null)
        .maybeSingle()
      if (recErr) throw recErr
      if (!rec) return res.status(404).json({ error: { message: 'Recommendation not found.', status: 404 } })
      res.json(
        await toggleUpvote({
          supabase,
          table: 'guide_upvotes',
          refColumn: 'rec_id',
          refId: recId,
          userId,
          now: new Date().toISOString(),
          syncCount: () => communityCounters.syncGuideRecUpvotes(recId),
        }),
      )
    } catch (e) {
      return respondGuideDbError(res, e)
    }
  })

  router.patch('/api/guide/:id/pin', userWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    const pinned = req.body?.pinned === true || req.body?.pinned === 'true'
    try {
      const { data, error } = await supabase
        .from('guide_recommendations')
        .update({ pinned })
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .select('id')
      if (error) throw error
      if (!data?.length) return res.status(404).json({ error: { message: 'Recommendation not found.', status: 404 } })
      res.json({ ok: true, pinned })
    } catch (e) {
      return respondGuideDbError(res, e)
    }
  })

  // Delete - owner or admin (admins take down live recommendations, issue #195).
  router.delete('/api/guide/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const query = supabase
        .from('guide_recommendations')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .is('deleted_at', null)
      const { data, error } = await ownerOrAdminScope(query, { userId, isAdmin: isUserAdmin(req.currentUser) }).select('id')
      if (error) throw error
      if (!data?.length) {
        return res.status(404).json({ error: { message: 'Recommendation not found or not yours.', status: 404 } })
      }
      res.status(204).end()
    } catch (e) {
      return respondGuideDbError(res, e)
    }
  })

  return router
}
