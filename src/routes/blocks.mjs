import express from 'express'
import { MAX_BLOCKS } from '../blocks.mjs'
import { REPORT_TARGETS } from '../contentReports.mjs'
import { badRequest, DB_FEATURES, isSchemaMissingError, respondDbError } from '../dbErrors.mjs'
import { requireIdParam } from '../httpGuards.mjs'

// Blocking users (issue #192). A student blocks another student directly (from
// a match card, a connection or an incoming request), or blocks the author of a
// post by the post, since no list on the board, lost and found, the guide,
// study groups or the marketplace names its authors. The by-content route
// resolves the author here and answers the same way whether or not the content
// exists or who wrote it. Anonymous board posts and replies cannot be blocked
// at all (owner decision, 2026-09-27): the Blocked users list names everyone
// it holds, so blocking an anonymous author would unmask them. Those are
// reported instead, and a direct block still hides that person's anonymous
// posts, because the filter reads user_id. A block removes the pair's
// connections in both directions.

// Every reportable content type except a user, which has its own route.
const CONTENT_TYPES = new Set(Object.keys(REPORT_TARGETS).filter((type) => type !== 'user'))
// The content types that can be posted anonymously, with the flag's column.
const ANONYMOUS_COLUMN = { board_post: 'is_anon', board_reply: 'is_anon' }
const LIMIT_MESSAGE = 'You have reached the limit of blocked users.'
const ANONYMOUS_MESSAGE = 'Anonymous posts cannot be blocked. Report it instead.'

async function countBlocks(supabase, userId) {
  const { count, error } = await supabase
    .from('blocked_users')
    .select('blocked_id', { count: 'exact', head: true })
    .eq('blocker_id', userId)
  if (error) throw error
  return count || 0
}

// The block itself: the row (a repeat is not an error) and the pair's
// connections, whichever of them asked.
async function blockUser(supabase, userId, blockedId) {
  const { error } = await supabase.from('blocked_users').insert({ blocker_id: userId, blocked_id: blockedId })
  if (error && error.code !== '23505') throw error
  const { error: connErr } = await supabase
    .from('connections')
    .delete()
    .or(`and(requester_id.eq.${userId},addressee_id.eq.${blockedId}),and(requester_id.eq.${blockedId},addressee_id.eq.${userId})`)
  if (connErr) throw connErr
}

/**
 * The block routes, mounted by server.mjs next to the report route.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase           the Supabase client
 * @param {Function} deps.requireAuth        loads req.currentUser or answers 401
 * @param {Function} deps.userWriteRateLimit the shared per-user write limiter
 */
export function createBlocksRouter({ supabase, requireAuth, userWriteRateLimit }) {
  const router = express.Router()

  // The caller's own blocks, newest first. Blocks by other people are not
  // listed: they only take effect.
  router.get('/api/me/blocks', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const { data, error } = await supabase
        .from('blocked_users')
        .select('blocked_id, created_at')
        .eq('blocker_id', userId)
        .order('created_at', { ascending: false })
        .limit(MAX_BLOCKS)
      if (error) throw error
      const rows = data || []
      const names = new Map()
      if (rows.length) {
        const { data: users, error: usersErr } = await supabase
          .from('users')
          .select('id, display_name')
          .in('id', rows.map((r) => r.blocked_id))
        if (usersErr) throw usersErr
        for (const u of users || []) names.set(u.id, u.display_name)
      }
      res.json({
        blocks: rows.map((r) => ({ userId: r.blocked_id, displayName: names.get(r.blocked_id) || 'Student', createdAt: r.created_at })),
      })
    } catch (e) {
      return respondDbError(res, e, DB_FEATURES.blocked_users)
    }
  })

  router.post('/api/me/blocks/:userId', userWriteRateLimit, requireIdParam('userId'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const blockedId = req.params.userId.toLowerCase()
    if (blockedId === String(userId).toLowerCase()) return badRequest(res, 'You cannot block yourself.')
    try {
      const { data: target, error: findErr } = await supabase.from('users').select('id').eq('id', blockedId).maybeSingle()
      if (findErr) throw findErr
      if (!target) return res.status(404).json({ error: { message: 'User not found.', status: 404 } })
      if ((await countBlocks(supabase, userId)) >= MAX_BLOCKS) return badRequest(res, LIMIT_MESSAGE)
      await blockUser(supabase, userId, blockedId)
      res.json({ ok: true })
    } catch (e) {
      return respondDbError(res, e, DB_FEATURES.blocked_users)
    }
  })

  // Block whoever wrote a piece of content. The answer is 200 { ok: true }
  // whether the content is gone, was the caller's own, or was blocked, so it
  // says nothing about authorship. Refused: a bad type, the limit (checked
  // first, so it cannot hint at existence) and an anonymous post, which the
  // student can already see is anonymous.
  router.post('/api/me/blocks/content/:targetType/:targetId', userWriteRateLimit, requireIdParam('targetId'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { targetType } = req.params
    if (!CONTENT_TYPES.has(targetType)) return res.status(404).json({ error: { message: 'Not found.', status: 404 } })
    const target = REPORT_TARGETS[targetType]
    const anonColumn = ANONYMOUS_COLUMN[targetType]
    try {
      if ((await countBlocks(supabase, userId)) >= MAX_BLOCKS) return badRequest(res, LIMIT_MESSAGE)
      const { data: row, error: findErr } = await supabase
        .from(target.table)
        .select(anonColumn ? `id, ${target.authorColumn}, ${anonColumn}` : `id, ${target.authorColumn}`)
        .eq('id', req.params.targetId.toLowerCase())
        .maybeSingle()
      // A feature whose table is not installed has no content to block anyone by.
      if (findErr && !isSchemaMissingError(findErr)) throw findErr
      if (anonColumn && row?.[anonColumn]) return badRequest(res, ANONYMOUS_MESSAGE)
      const authorId = row?.[target.authorColumn]
      if (authorId && authorId !== userId) await blockUser(supabase, userId, authorId)
      res.json({ ok: true })
    } catch (e) {
      return respondDbError(res, e, DB_FEATURES.blocked_users)
    }
  })

  // Idempotent: unblocking someone who is not blocked is still ok.
  router.delete('/api/me/blocks/:userId', userWriteRateLimit, requireIdParam('userId'), requireAuth, async (req, res) => {
    try {
      const { error } = await supabase
        .from('blocked_users')
        .delete()
        .eq('blocker_id', req.currentUser.id)
        .eq('blocked_id', req.params.userId.toLowerCase())
      if (error) throw error
      res.json({ ok: true })
    } catch (e) {
      return respondDbError(res, e, DB_FEATURES.blocked_users)
    }
  })

  return router
}
