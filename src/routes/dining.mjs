import express from 'express'
import { badRequest, respondRouteError } from '../dbErrors.mjs'
import { normalizeItemName } from '../diningFavorites.mjs'
import { clampDiningDate } from '../nutrisliceDining.mjs'
import { DINING_FAVORITES_CAP_MESSAGE, MAX_DINING_FAVORITES, capCheck } from '../userWriteCaps.mjs'

// Dining: the public Nutrislice menu snapshot and each student's favorite
// menu items. Moved out of server.mjs as a feature router (issue #191) with
// the handlers unchanged. Two routers, because the snapshot is one of the
// session-free public reads registered ahead of the session middleware so the
// edge can cache it (issue #250), while the favorites need the session.

/**
 * GET /api/dining, the public menu snapshot. server.mjs mounts this in its
 * public reads block, before the session middleware, where the route used to
 * be registered, so the response never carries the session cookie. Paths stay
 * absolute (`/api/dining`) so docs/RATE_LIMITS.md and its guard test read the
 * same whether a route lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {Function} deps.publicReadIpRateLimit the per-address cap across the public reads
 * @param {Function} deps.publicReadRateLimit   the shared public-read bucket
 * @param {Function} deps.getDiningSnapshot     getDiningSnapshot from src/nutrisliceDining.mjs, injected
 *   because server.mjs also hands it to the assistant
 */
export function createDiningPublicRouter({ publicReadIpRateLimit, publicReadRateLimit, getDiningSnapshot }) {
  const router = express.Router()

  async function handleDining(req, res) {
    try {
      // `refresh` passes through as a hint (the module refetches a date at most
      // every ten minutes); `date` must be yesterday to today + 14 (issue #208).
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true'
      let date
      if (req.query.date !== undefined && req.query.date !== '') {
        const checked = clampDiningDate(req.query.date)
        if (!checked.ok) return res.status(400).json({ ok: false, error: 'dining_bad_date', locations: [] })
        date = checked.ymd
      }
      const data = await getDiningSnapshot({ forceRefresh, date })
      // The module refetches a date at most every ten minutes, so two minutes in
      // the browser and five at the edge never serve a menu the backend would
      // not have served itself (issue #250). Two answers are never stored: the
      // module's outage snapshot (a 200 with ok: false and no locations), which
      // would otherwise pin the outage past its own retry, and a forced refresh,
      // which has to reach the backend to mean anything.
      if (data.ok && !forceRefresh) res.set('Cache-Control', 'public, max-age=120, s-maxage=300')
      else res.set('Cache-Control', 'no-store')
      res.json(data)
    } catch (error) {
      console.error('Nutrislice dining error:', error)
      res.status(500).json({ ok: false, error: 'dining_internal', locations: [] })
    }
  }

  router.get('/api/dining', publicReadIpRateLimit, publicReadRateLimit, handleDining)

  return router
}

// ---- Dining favorites (issue #49) ---------------------------------------
// Per-user favorited menu-item names. The Dining page stars items and shows a
// "your favorites on today's menu" section by cross-referencing these against
// the public /api/dining snapshot. Requires db/supabase-dining-favorites.sql.

/**
 * The dining favorites routes, mounted by server.mjs where they used to be,
 * behind the session.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase           the Supabase client
 * @param {Function} deps.requireAuth        loads req.currentUser or answers 401
 * @param {Function} deps.userWriteRateLimit the shared per-user write limiter
 */
export function createDiningRouter({ supabase, requireAuth, userWriteRateLimit }) {
  const router = express.Router()

  router.get('/api/me/dining/favorites', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const { data, error } = await supabase
        .from('user_dining_favorites')
        .select('item_name')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
      if (error) throw error
      res.json({ favorites: (data || []).map((r) => r.item_name) })
    } catch (e) {
      // Degrade gracefully so the dining page still renders without favorites.
      console.error('GET /api/me/dining/favorites:', e?.message || e)
      res.json({ favorites: [], unavailable: true })
    }
  })

  router.post('/api/me/dining/favorites', userWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const itemName = normalizeItemName(req.body?.itemName)
    if (!itemName) return badRequest(res, 'An item name is required')
    try {
      // Keyed by (user_id, item_name), no id column. Counting the other favorites
      // lets a re-save of one the user already has through at the cap.
      const countResult = await supabase
        .from('user_dining_favorites')
        .select('item_name', { count: 'exact', head: true })
        .eq('user_id', userId)
        .neq('item_name', itemName)
      const cap = capCheck(countResult, MAX_DINING_FAVORITES)
      if (cap.failure) console.error('POST /api/me/dining/favorites:', cap.failure, countResult.error)
      if (cap.blocked) {
        return res.status(409).json({ error: { message: DINING_FAVORITES_CAP_MESSAGE, status: 409 } })
      }
      const { error } = await supabase
        .from('user_dining_favorites')
        .upsert({ user_id: userId, item_name: itemName }, { onConflict: 'user_id,item_name' })
      if (error) throw error
      res.json({ ok: true, itemName })
    } catch (e) {
      respondRouteError(res, e, { label: 'POST /api/me/dining/favorites', fallback: 'Could not save favorite' })
    }
  })

  router.delete('/api/me/dining/favorites', userWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const itemName = normalizeItemName(req.body?.itemName ?? req.query?.itemName)
    if (!itemName) return badRequest(res, 'An item name is required')
    try {
      const { error } = await supabase
        .from('user_dining_favorites')
        .delete()
        .eq('user_id', userId)
        .eq('item_name', itemName)
      if (error) throw error
      res.json({ ok: true })
    } catch (e) {
      respondRouteError(res, e, { label: 'DELETE /api/me/dining/favorites', fallback: 'Could not remove favorite' })
    }
  })

  return router
}
