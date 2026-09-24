import express from 'express'
import { defaultLayout, normalizeLayout } from '../dashboardLayout.mjs'
import {
  defaultLayout as defaultServicesLayout,
  normalizeLayout as normalizeServicesLayout,
} from '../servicesLayout.mjs'

/**
 * The customizable board layouts (issue #191, first router out of server.mjs):
 * the home dashboard (issue #52) and the Student Services board. Per-user
 * widget order, size and visibility, stored as JSONB on users. NULL means the
 * user has never customized, so the client applies the default layout. The
 * validation rules live in src/dashboardLayout.mjs and src/servicesLayout.mjs,
 * shared verbatim with the frontend so the widget catalogue cannot drift.
 *
 * Paths stay absolute (`/api/me/dashboard`) so docs/RATE_LIMITS.md and its
 * guard test read the same whether a route lives here or in server.mjs.
 *
 * @param {object} deps
 * @param {object} deps.supabase             the Supabase client
 * @param {Function} deps.requireAuth        loads req.currentUser or answers 401
 * @param {Function} deps.userWriteRateLimit the shared per-user write limiter
 */
export function createLayoutsRouter({ supabase, requireAuth, userWriteRateLimit }) {
  const router = express.Router()

  router.get('/api/me/dashboard', requireAuth, async (req, res) => {
    const stored = req.currentUser.dashboard_layout
    // Never customized: return the default so the client always has a layout.
    const layout = stored == null ? defaultLayout() : normalizeLayout(stored)
    res.json({ layout })
  })

  router.put('/api/me/dashboard', userWriteRateLimit, requireAuth, async (req, res) => {
    // Sanitize untrusted client input against the widget allowlist before storing.
    const layout = normalizeLayout(req.body?.layout)
    const { error } = await supabase
      .from('users')
      .update({ dashboard_layout: layout })
      .eq('id', req.currentUser.id)
    if (error) {
      console.error('PUT /api/me/dashboard:', error.message)
      return res.status(500).json({ error: { message: 'Could not save your dashboard layout.', status: 500 } })
    }
    res.json({ layout })
  })

  router.get('/api/me/services', requireAuth, async (req, res) => {
    const stored = req.currentUser.services_layout
    // Never customized: return the default so the client always has a layout.
    const layout = stored == null ? defaultServicesLayout() : normalizeServicesLayout(stored)
    res.json({ layout })
  })

  router.put('/api/me/services', userWriteRateLimit, requireAuth, async (req, res) => {
    // Sanitize untrusted client input against the widget allowlist before storing.
    const layout = normalizeServicesLayout(req.body?.layout)
    const { error } = await supabase
      .from('users')
      .update({ services_layout: layout })
      .eq('id', req.currentUser.id)
    if (error) {
      console.error('PUT /api/me/services:', error.message)
      return res.status(500).json({ error: { message: 'Could not save your services layout.', status: 500 } })
    }
    res.json({ layout })
  })

  return router
}
