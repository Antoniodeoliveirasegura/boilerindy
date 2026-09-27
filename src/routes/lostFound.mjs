import express from 'express'
import { excludeAuthors, loadBlockedIds } from '../blocks.mjs'
import { assertBoardPostTextAllowed } from '../boardProfanity.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { ownerOrAdminScope } from '../moderation.mjs'
import { sanitizeSearchTerm } from '../searchTerm.mjs'

// Lost & Found (issue #47): a standalone feature, independent of the board.
// Students post lost or found items, search them and mark their own posts
// resolved; the owner or an admin can take a post down (soft delete, issue
// #195). Moved out of server.mjs as a feature router (issue #191) with the
// handlers unchanged.

const LOST_FOUND_TYPES = new Set(['lost', 'found'])

function mapLostFoundRow(row, userId) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    location: row.location,
    contact: row.contact,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isOwner: row.user_id === userId,
  }
}

function cleanField(value, max) {
  const trimmed = String(value ?? '').trim()
  return trimmed ? trimmed.slice(0, max) : null
}

/**
 * The Lost & Found routes, mounted by server.mjs where they used to be.
 * Paths stay absolute (`/api/lost-found`) so docs/RATE_LIMITS.md and its
 * guard test read the same whether a route lives here or in server.mjs.
 *
 * @param {object} deps
 * @param {object} deps.supabase                  the Supabase client
 * @param {Function} deps.requireAuth             loads req.currentUser or answers 401
 * @param {Function} deps.isUserAdmin             true for an admin (reads the admin emails server.mjs holds)
 * @param {Function} deps.lostFoundWriteRateLimit the create and edit limiter
 * @param {Function} deps.userWriteRateLimit      the shared per-user write limiter
 */
export function createLostFoundRouter({ supabase, requireAuth, isUserAdmin, lostFoundWriteRateLimit, userWriteRateLimit }) {
  const router = express.Router()

  router.get('/api/lost-found', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const type = typeof req.query.type === 'string' && LOST_FOUND_TYPES.has(req.query.type) ? req.query.type : null
    const status = req.query.status === 'resolved' || req.query.status === 'open' ? req.query.status : null
    const search = typeof req.query.q === 'string' ? sanitizeSearchTerm(req.query.q) : ''

    let blocked
    try {
      blocked = await loadBlockedIds(supabase, userId)
    } catch (err) {
      console.error('GET /api/lost-found:', err.message)
      return res.json({ items: [], unavailable: true })
    }

    let query = supabase
      .from('lost_found_items')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200)

    if (type) query = query.eq('type', type)
    if (status) query = query.eq('status', status)
    if (search) query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%,location.ilike.%${search}%`)
    // Users on either side of a block with the caller are left out (#192).
    query = excludeAuthors(query, 'user_id', blocked)

    const { data, error } = await query
    if (error) {
      console.error('GET /api/lost-found:', error.message)
      return res.json({ items: [], unavailable: true })
    }
    res.json({ items: (data || []).map((row) => mapLostFoundRow(row, userId)) })
  })

  router.post('/api/lost-found', lostFoundWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const type = String(req.body?.type || '').trim()
    if (!LOST_FOUND_TYPES.has(type)) {
      return res.status(400).json({ error: { message: 'Type must be "lost" or "found".', status: 400 } })
    }
    const title = cleanField(req.body?.title, 200)
    if (!title) {
      return res.status(400).json({ error: { message: 'A short title is required.', status: 400 } })
    }
    const description = cleanField(req.body?.description, 2000)
    const location = cleanField(req.body?.location, 200)
    const contact = cleanField(req.body?.contact, 200)

    // Reuse the campus board's profanity policy so all user text is moderated.
    const policy = assertBoardPostTextAllowed(title, `${description || ''}\n${location || ''}`)
    if (!policy.ok) {
      return res.status(400).json({ error: { message: policy.message, status: 400 } })
    }

    const { data, error } = await supabase
      .from('lost_found_items')
      .insert({ user_id: userId, type, title, description, location, contact, status: 'open' })
      .select()
      .single()
    if (error) {
      console.error('POST /api/lost-found:', error.message)
      return res.status(500).json({ error: { message: 'Could not save your post. Please try again.', status: 500 } })
    }
    res.status(201).json({ item: mapLostFoundRow(data, userId) })
  })

  router.patch('/api/lost-found/:id', lostFoundWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { id } = req.params

    const { data: existing, error: findErr } = await supabase
      .from('lost_found_items')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (findErr || !existing) {
      return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })
    }
    if (existing.user_id !== userId) {
      // Uniform 404 (not 403) so this can't be used as an existence oracle.
      return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })
    }

    const patch = {}
    if (req.body?.status === 'resolved' || req.body?.status === 'open') patch.status = req.body.status
    if (req.body?.title !== undefined) {
      const title = cleanField(req.body.title, 200)
      if (!title) return res.status(400).json({ error: { message: 'Title cannot be empty.', status: 400 } })
      patch.title = title
    }
    if (req.body?.description !== undefined) patch.description = cleanField(req.body.description, 2000)
    if (req.body?.location !== undefined) patch.location = cleanField(req.body.location, 200)
    if (req.body?.contact !== undefined) patch.contact = cleanField(req.body.contact, 200)

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: { message: 'Nothing to update.', status: 400 } })
    }

    const nextTitle = patch.title ?? existing.title
    const nextDesc = patch.description ?? existing.description
    const nextLoc = patch.location ?? existing.location
    const policy = assertBoardPostTextAllowed(nextTitle, `${nextDesc || ''}\n${nextLoc || ''}`)
    if (!policy.ok) {
      return res.status(400).json({ error: { message: policy.message, status: 400 } })
    }

    const { data, error } = await supabase
      .from('lost_found_items')
      .update(patch)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()
    if (error) {
      console.error('PATCH /api/lost-found/:id:', error.message)
      return res.status(500).json({ error: { message: 'Could not update the post.', status: 500 } })
    }
    res.json({ item: mapLostFoundRow(data, userId) })
  })

  router.delete('/api/lost-found/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { id } = req.params
    // Soft delete: hide the item (set deleted_at) instead of removing it. The
    // owner or an admin taking it down (issue #195) can delete; admins can
    // restore or permanently delete it from the moderation view.
    const query = supabase
      .from('lost_found_items')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
    const { data, error } = await ownerOrAdminScope(query, { userId, isAdmin: isUserAdmin(req.currentUser) }).select('id')
    if (error) {
      console.error('DELETE /api/lost-found/:id:', error.message)
      return res.status(500).json({ error: { message: 'Could not delete the post.', status: 500 } })
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })
    }
    res.json({ ok: true })
  })

  return router
}
