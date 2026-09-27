import express from 'express'
import { isDealActive, mapDealRow, validateDealInput } from '../campusDeals.mjs'
import { DB_FEATURES, respondSoftDeleteFeatureDbError } from '../dbErrors.mjs'
import { requireIdParam } from '../httpGuards.mjs'

// Campus Perks (issue #24): admin-curated local deals for students. GET is
// for everyone (active and unexpired); create, edit and delete require admin.
// Requires db/supabase-campus-deals.sql, and db/supabase-soft-delete.sql for
// the deleted_at column. Moved out of server.mjs as a feature router (issue
// #191) with the handlers unchanged.

function respondDealsDbError(res, err) {
  return respondSoftDeleteFeatureDbError(res, err, DB_FEATURES.deals)
}

/**
 * The Campus Perks routes, mounted by server.mjs where they used to be.
 * Paths stay absolute (`/api/deals`) so docs/RATE_LIMITS.md and its guard
 * test read the same whether a route lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase           the Supabase client
 * @param {Function} deps.requireAuth        loads req.currentUser or answers 401
 * @param {Function} deps.requireAdmin       answers 403 unless req.currentUser is an admin
 * @param {Function} deps.isUserAdmin        true for an admin: drives ?all=1 and the isAdmin field
 * @param {Function} deps.userWriteRateLimit the shared per-user write limiter
 */
export function createDealsRouter({ supabase, requireAuth, requireAdmin, isUserAdmin, userWriteRateLimit }) {
  const router = express.Router()

  router.get('/api/deals', requireAuth, async (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : ''
    // Admins can request everything (incl. inactive/expired) to manage from the UI.
    const includeAll = req.query.all === '1' && isUserAdmin(req.currentUser)
    try {
      let query = supabase.from('deals').select('*').is('deleted_at', null).order('featured', { ascending: false }).order('created_at', { ascending: false }).limit(200)
      if (category) query = query.eq('category', category)
      const { data, error } = await query
      if (error) throw error
      const rows = includeAll ? (data || []) : (data || []).filter((d) => isDealActive(d))
      res.json({ deals: rows.map(mapDealRow), isAdmin: isUserAdmin(req.currentUser) })
    } catch (e) {
      return respondDealsDbError(res, e)
    }
  })

  router.post('/api/deals', userWriteRateLimit, requireAuth, requireAdmin, async (req, res) => {
    const { value, error: invalid } = validateDealInput(req.body || {}, { partial: false })
    if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })
    try {
      const { data, error } = await supabase
        .from('deals')
        .insert({ ...value, created_by: req.currentUser.id })
        .select('*')
        .single()
      if (error) throw error
      res.status(201).json({ deal: mapDealRow(data) })
    } catch (e) {
      return respondDealsDbError(res, e)
    }
  })

  router.patch('/api/deals/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    const { value, error: invalid } = validateDealInput(req.body || {}, { partial: true })
    if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })
    if (Object.keys(value).length === 0) {
      return res.status(400).json({ error: { message: 'No valid fields to update.', status: 400 } })
    }
    try {
      const { data, error } = await supabase.from('deals').update(value).eq('id', req.params.id).is('deleted_at', null).select('*').maybeSingle()
      if (error) throw error
      if (!data) return res.status(404).json({ error: { message: 'Deal not found.', status: 404 } })
      res.json({ deal: mapDealRow(data) })
    } catch (e) {
      return respondDealsDbError(res, e)
    }
  })

  router.delete('/api/deals/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('deals').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id).is('deleted_at', null).select('id')
      if (error) throw error
      if (!data?.length) return res.status(404).json({ error: { message: 'Deal not found.', status: 404 } })
      res.status(204).end()
    } catch (e) {
      return respondDealsDbError(res, e)
    }
  })

  return router
}
