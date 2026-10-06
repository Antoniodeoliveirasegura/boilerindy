import crypto from 'node:crypto'
import express from 'express'
import { excludeBlocked, loadBlockedIds } from '../blocks.mjs'
import {
  BOARD_PAGE_SIZE,
  INLINE_REPLIES,
  INLINE_REPLY_FETCH_LIMIT,
  REPLY_PAGE_SIZE,
  validateBoardPost,
  validateBoardReply,
} from '../boardLimits.mjs'
import {
  assertBoardPostTextAllowed,
  boardTextFailsPolicy,
  BOARD_PROFANITY_USER_MESSAGE,
} from '../boardProfanity.mjs'
import { groupRepliesByPost, mapBoardReply } from '../boardReplies.mjs'
import { badRequest, DB_FEATURES, respondSoftDeleteFeatureDbError } from '../dbErrors.mjs'
import { GroqUpstreamError } from '../groqClient.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { ownerOrAdminScope } from '../moderation.mjs'
import { toggleUpvote } from '../upvoteToggle.mjs'

// The campus board: posts, replies, upvotes, owner edits and soft deletes,
// and two AI helpers on the Groq client the assistant shares, the compose and
// reply suggestions and the auto-tagger inside POST /api/board/posts. Tables:
// db/supabase-board-only.sql, and db/supabase-soft-delete.sql for the
// deleted_at column. Moved out of server.mjs as a feature router (issue #191)
// with the handlers unchanged apart from nowIso() and makeId() inlined, and
// the two GROQ_API_KEY checks asking the client instead (ai.enabled is
// Boolean(GROQ_API_KEY)), so the key itself stays in server.mjs.

// 503 board_schema_missing until the board tables exist, 500 otherwise: the
// same wrapper over src/dbErrors.mjs (#218) as every feature's responder.
function respondBoardDbError(res, err) {
  return respondSoftDeleteFeatureDbError(res, err, DB_FEATURES.board)
}

const BOARD_TAG_CANDIDATES = [
  'dining', 'parking', 'tutoring', 'housing', 'transit', 'library',
  'career', 'health', 'clubs', 'sports', 'tech', 'financial-aid',
  'study-spots', 'events', 'classes', 'safety',
]

/**
 * The campus board routes, mounted by server.mjs where they used to be.
 * Paths stay absolute (`/api/board/posts`) so docs/RATE_LIMITS.md and its
 * guard test read the same whether a route lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase            the Supabase client
 * @param {Function} deps.requireAuth         loads req.currentUser or answers 401
 * @param {Function} deps.isUserAdmin         true for an admin: lets the delete past the owner filter
 * @param {object}   deps.communityCounters   createCommunityCounters(supabase): the reply and upvote recounts
 * @param {object}   deps.ai                  the Groq client the assistant shares (src/groqClient.mjs);
 *   ai.enabled is false without GROQ_API_KEY, and then neither AI helper calls it
 * @param {Function} deps.boardAiRateLimit    the compose and reply suggestion limiter (ai-board)
 * @param {object}   deps.boardTagWindow      the auto-tagger's createRateWindow (ai-board-tags), hit once per post
 * @param {Function} deps.boardWriteRateLimit the community write limiter (post, reply, upvote, edit)
 * @param {Function} deps.userWriteRateLimit  the shared per-user write limiter (delete)
 */
export function createBoardRouter({
  supabase,
  requireAuth,
  isUserAdmin,
  communityCounters,
  ai,
  boardAiRateLimit,
  boardTagWindow,
  boardWriteRateLimit,
  userWriteRateLimit,
}) {
  const router = express.Router()

  // Display names for the non-anonymous authors of a batch of posts or replies.
  // Anonymous rows never reach the lookup, so an author who only ever posts
  // anonymously is never read.
  async function boardDisplayNames(...rowSets) {
    const userIds = new Set()
    for (const rows of rowSets) {
      for (const row of rows) { if (!row.is_anon) userIds.add(row.user_id) }
    }
    const nameMap = {}
    if (userIds.size === 0) return nameMap
    const { data } = await supabase.from('users').select('id, display_name').in('id', [...userIds])
    for (const u of data || []) nameMap[u.id] = u.display_name
    return nameMap
  }

  router.get('/api/board/posts', requireAuth, async (req, res) => {
    const sort = req.query.sort === 'popular' ? 'popular' : 'recent'
    const page = Math.max(0, parseInt(req.query.page, 10) || 0)

    // Users on either side of a block with the caller are left out in the
    // queries, so paging stays exact (issue #192). Anonymous posts keep their
    // user_id, so the filter covers them too.
    let blocked
    try {
      blocked = await loadBlockedIds(supabase, req.currentUser.id)
    } catch (err) {
      return respondBoardDbError(res, err)
    }

    // select('*') keeps the board working whether or not the optional
    // edited_at migration (db/supabase-board-only.sql) has been applied yet
    let query = supabase
      .from('board_posts')
      .select('*')
      .is('deleted_at', null)
    query = excludeBlocked(query, 'user_id', blocked)
    if (sort === 'popular') {
      query = query
        .order('pinned', { ascending: false })
        .order('upvote_count', { ascending: false })
        .order('created_at', { ascending: false })
    } else {
      query = query
        .order('pinned', { ascending: false })
        .order('created_at', { ascending: false })
    }
    const { data: postsData, error: postsError } = await query
      .range(page * BOARD_PAGE_SIZE, page * BOARD_PAGE_SIZE + BOARD_PAGE_SIZE - 1)
    if (postsError) return respondBoardDbError(res, postsError)

    const postIds = postsData.map(p => p.id)
    let repliesData = []
    if (postIds.length > 0) {
      // Newest first with a hard cap (issue #200): only the newest INLINE_REPLIES
      // per post are previewed, and the rest of a thread comes from
      // GET /api/board/posts/:id/replies.
      const replyQuery = supabase
        .from('board_replies')
        .select('id, post_id, body, is_anon, created_at, user_id')
        .in('post_id', postIds)
      const { data: rd } = await excludeBlocked(replyQuery, 'user_id', blocked)
        .order('created_at', { ascending: false })
        .limit(INLINE_REPLY_FETCH_LIMIT)
      repliesData = rd || []
    }
    const { byPost: inlineReplies, truncatedPostIds } = groupRepliesByPost(repliesData, { perPost: INLINE_REPLIES })
    const truncated = new Set(truncatedPostIds)
    // The reply budget is global. When it binds, a post that came back with fewer
    // than INLINE_REPLIES may have been starved by a busier thread rather than be
    // short, so it keeps its marker and loads the thread from the replies route.
    const replyFetchCapped = repliesData.length >= INLINE_REPLY_FETCH_LIMIT
    const previewedReplies = Object.values(inlineReplies).flat()

    const nameMap = await boardDisplayNames(postsData, previewedReplies)

    let upvotedIds = new Set()
    if (postIds.length > 0) {
      const { data: uv } = await supabase
        .from('board_upvotes')
        .select('post_id')
        .eq('user_id', req.currentUser.id)
        .in('post_id', postIds)
      if (uv) uv.forEach(r => upvotedIds.add(r.post_id))
    }

    const myId = req.currentUser.id
    const posts = postsData.map(p => {
      const replies = (inlineReplies[p.id] || []).map(r => mapBoardReply(r, nameMap, myId))
      // reply_count is maintained by sync_board_post_reply_count; fall back to what
      // is on screen so a post still counts its replies on an unmigrated database.
      const replyCount = Number.isFinite(p.reply_count) ? p.reply_count : replies.length
      return {
        id: p.id,
        title: p.title,
        body: p.body,
        anon: p.is_anon,
        user: p.is_anon ? 'Anonymous' : (nameMap[p.user_id] || 'Student'),
        upvotes: p.upvote_count,
        pinned: p.pinned,
        hot: !p.pinned && p.upvote_count >= 10,
        time: p.created_at,
        tags: Array.isArray(p.tags) ? p.tags : [],
        editedTime: p.edited_at || null,
        upvotedByMe: upvotedIds.has(p.id),
        isMine: p.user_id === myId,
        replies,
        replyCount,
        hasMoreReplies: truncated.has(p.id)
          || replyCount > replies.length
          || (replyFetchCapped && replies.length < INLINE_REPLIES),
      }
    })

    res.json({ posts, page, hasMore: postsData.length === BOARD_PAGE_SIZE })
  })

  // The rest of a thread the list route only previewed (issue #200). A read, so no
  // write limiter; requireIdParam answers 404 for a non-uuid before the handler.
  router.get('/api/board/posts/:id/replies', requireIdParam('id'), requireAuth, async (req, res) => {
    const postId = req.params.id
    const page = Math.max(0, parseInt(req.query.page, 10) || 0)

    const { data: post, error: postError } = await supabase
      .from('board_posts')
      .select('id')
      .eq('id', postId)
      .is('deleted_at', null)
      .maybeSingle()
    if (postError) return respondBoardDbError(res, postError)
    if (!post) return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })

    // Replies by users on either side of a block are left out (issue #192).
    let blocked
    try {
      blocked = await loadBlockedIds(supabase, req.currentUser.id)
    } catch (err) {
      return respondBoardDbError(res, err)
    }
    const replyQuery = supabase
      .from('board_replies')
      .select('id, post_id, body, is_anon, created_at, user_id')
      .eq('post_id', postId)
    const { data, error } = await excludeBlocked(replyQuery, 'user_id', blocked)
      .order('created_at', { ascending: true })
      .range(page * REPLY_PAGE_SIZE, page * REPLY_PAGE_SIZE + REPLY_PAGE_SIZE - 1)
    if (error) return respondBoardDbError(res, error)

    const rows = data || []
    const nameMap = await boardDisplayNames(rows)
    res.json({
      replies: rows.map(r => mapBoardReply(r, nameMap, req.currentUser.id)),
      page,
      hasMore: rows.length === REPLY_PAGE_SIZE,
    })
  })

  router.post('/api/board/ai-suggestions', requireAuth, boardAiRateLimit, async (req, res) => {
    if (!ai.enabled) {
      return res.status(503).json({
        error: { message: 'AI suggestions are not configured.', status: 503 },
      })
    }

    const context = req.body.context === 'reply' ? 'reply' : 'compose'
    const title = String(req.body.title || '').trim().slice(0, 300)
    const body = String(req.body.body || '').trim().slice(0, 1200)
    const postTitle = String(req.body.postTitle || '').trim().slice(0, 300)
    const postBody = String(req.body.postBody || '').trim().slice(0, 800)
    const draft = String(req.body.draft || '').trim().slice(0, 1000)

    if (context === 'compose') {
      if (title.length < 6 && body.length < 20) {
        return res.json({ betterTitle: null, bodyAddOn: null, tags: [] })
      }
    } else if (draft.length < 8) {
      return res.json({ replyTip: null })
    }

    const tagList = BOARD_TAG_CANDIDATES.join(', ')
    const userText =
      context === 'compose'
        ? `The student is composing a question for a Purdue Indianapolis campus board.\n\nTitle (draft):\n${title}\n\nBody (draft):\n${body || '(empty)'}\n\nReturn ONLY a JSON object, no markdown code fences, with this exact shape:\n{"betterTitle":string|null,"bodyAddOn":string|null,"tags":string[]}\n\n- betterTitle: a clearer full title under 120 characters, or null if the draft title is already good.\n- bodyAddOn: one short optional sentence they could add for context (location, course, deadline), or null if not needed.\n- tags: 0 to 3 items, each must be exactly one of: ${tagList}\nUse JSON null (not the string "null") where appropriate.`
        : `Campus board thread title: ${postTitle}\nOriginal post:\n${postBody || '(no body)'}\n\nStudent's reply draft:\n${draft}\n\nReturn ONLY JSON: {"replyTip":string|null} - one concise coaching sentence (tone, specificity, or missing info), or null if the draft is fine.`

    try {
      const raw = (await ai.reply({
        messages: [{ role: 'user', content: userText }],
        maxOutputTokens: 350,
        temperature: 0.35,
      })) ?? '{}'
      // Models still wrap JSON in prose or fences now and then, so pull out the
      // object rather than parsing the whole reply.
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) {
        return context === 'compose'
          ? res.json({ betterTitle: null, bodyAddOn: null, tags: [] })
          : res.json({ replyTip: null })
      }
      let parsed
      try {
        parsed = JSON.parse(match[0])
      } catch {
        return context === 'compose'
          ? res.json({ betterTitle: null, bodyAddOn: null, tags: [] })
          : res.json({ replyTip: null })
      }

      if (context === 'compose') {
        const betterTitle =
          typeof parsed.betterTitle === 'string' ? parsed.betterTitle.trim().slice(0, 120) : null
        const bodyAddOn =
          typeof parsed.bodyAddOn === 'string' ? parsed.bodyAddOn.trim().slice(0, 400) : null
        const tags = Array.isArray(parsed.tags)
          ? parsed.tags
              .filter((t) => typeof t === 'string' && BOARD_TAG_CANDIDATES.includes(t.toLowerCase()))
              .map((t) => t.toLowerCase())
              .slice(0, 3)
          : []
        res.json({
          betterTitle: betterTitle || null,
          bodyAddOn: bodyAddOn || null,
          tags,
        })
      } else {
        const replyTip =
          typeof parsed.replyTip === 'string' ? parsed.replyTip.trim().slice(0, 240) : null
        res.json({ replyTip: replyTip || null })
      }
    } catch (e) {
      if (e instanceof GroqUpstreamError) {
        console.error('Board AI suggestions:', e.body)
        return res.status(502).json({ error: { message: 'AI service error', status: 502 } })
      }
      console.error('Board AI suggestions:', e?.message || e)
      return res.status(500).json({ error: { message: 'Suggestion request failed', status: 500 } })
    }
  })

  async function autoTagBoardPost(postId, title, body, userId) {
    if (!ai.enabled) return []
    // Fire-and-forget calls used to skip the quota entirely, so a posting loop
    // could run up the inference bill unmetered. Tagging is a nicety; dropping it
    // over the limit costs the student nothing.
    if (userId && !boardTagWindow.hit(userId).allowed) return []
    const combined = `${title}\n${body}`.slice(0, 400)
    try {
      // 200 rather than 60 completion tokens: the tag array is tiny, but gpt-oss
      // spends reasoning tokens against the same ceiling and a truncated reply
      // parses as no tags at all.
      const raw = (await ai.reply({
        system: `You are a campus board post auto-tagger. Given a student's post, pick 1-3 of the most relevant tags from this list: ${BOARD_TAG_CANDIDATES.join(', ')}. Return ONLY a JSON array of strings, e.g. ["dining","parking"]. If nothing fits, return [].`,
        messages: [{ role: 'user', content: combined }],
        maxOutputTokens: 200,
        temperature: 0.1,
      })) ?? '[]'
      const match = raw.match(/\[.*\]/s)
      if (!match) return []
      const parsed = JSON.parse(match[0])
      const tags = parsed
        .filter((t) => typeof t === 'string' && BOARD_TAG_CANDIDATES.includes(t.toLowerCase()))
        .map((t) => t.toLowerCase())
        .slice(0, 3)
      if (tags.length) {
        await supabase.from('board_posts').update({ tags }).eq('id', postId)
      }
      return tags
    } catch (e) {
      console.error('Auto-tag error:', e?.message || e)
      return []
    }
  }

  router.post('/api/board/posts', boardWriteRateLimit, requireAuth, async (req, res) => {
    const title = String(req.body.title || '').trim()
    const body  = String(req.body.body  || '').trim()
    const isAnon = req.body.anon === true || req.body.anon === 'true'

    const limits = validateBoardPost({ title, body })
    if (!limits.ok) return badRequest(res, limits.message)

    const profanityCheck = assertBoardPostTextAllowed(title, body)
    if (!profanityCheck.ok) {
      return res.status(400).json({ error: { message: profanityCheck.message, status: 400 } })
    }

    const userId = req.currentUser.id
    if (!userId) {
      return res.status(401).json({ error: { message: 'Invalid session.', status: 401 } })
    }

    const { data, error } = await supabase
      .from('board_posts')
      .insert({
        user_id: userId,
        title,
        body: body || '',
        is_anon: isAnon,
      })
      .select('id, title, body, is_anon, pinned, upvote_count, reply_count, created_at')
      .single()

    if (error) return respondBoardDbError(res, error)

    // Fire-and-forget: AI assigns tags in the background
    const tagsPromise = autoTagBoardPost(data.id, title, body, req.session?.userId)

    // Respond immediately so the UI doesn't block on AI
    const postPayload = {
      id: data.id,
      title: data.title,
      body: data.body,
      anon: data.is_anon,
      user: data.is_anon ? 'Anonymous' : (req.currentUser.display_name || 'Student'),
      upvotes: 0,
      pinned: false,
      hot: false,
      time: data.created_at,
      upvotedByMe: false,
      isMine: true,
      tags: [],
      replies: [],
    }

    // Wait briefly (200ms) in case AI is fast, so the user sees tags immediately
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 200))
    const quickTags = await Promise.race([tagsPromise, timeout])
    if (Array.isArray(quickTags) && quickTags.length) {
      postPayload.tags = quickTags
    }

    res.status(201).json({ post: postPayload })
  })

  router.post('/api/board/posts/:id/reply', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const postId = req.params.id
    const body   = String(req.body.body || '').trim()
    const isAnon = req.body.anon === true || req.body.anon === 'true'

    const limits = validateBoardReply({ body })
    if (!limits.ok) return badRequest(res, limits.message)
    if (boardTextFailsPolicy(body)) {
      return res.status(400).json({ error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
    }

    const { data: post, error: postError } = await supabase
      .from('board_posts')
      .select('id')
      .eq('id', postId)
      .is('deleted_at', null)
      .maybeSingle()
    if (postError) return respondBoardDbError(res, postError)
    if (!post) return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })

    const id = crypto.randomUUID()
    const timestamp = new Date().toISOString()
    const { data: reply, error: replyError } = await supabase
      .from('board_replies')
      .insert({ id, post_id: postId, user_id: req.currentUser.id, body, is_anon: isAnon, created_at: timestamp })
      .select('id, body, is_anon, created_at')
      .single()

    if (replyError) return respondBoardDbError(res, replyError)

    // Recompute reply_count from the reply rows atomically (was read-modify-write,
    // which lost updates under concurrent replies). Best-effort: the reply is
    // already saved, and the next reply - or the backfill - self-heals a miss.
    const { error: countError } = await communityCounters.syncBoardPostReplies(postId)
    if (countError) console.error('board reply_count sync failed:', countError?.message || countError)

    res.status(201).json({
      reply: {
        id: reply.id,
        body: reply.body,
        user: reply.is_anon ? 'Anonymous' : req.currentUser.display_name,
        anon: reply.is_anon,
        isMine: true,
        time: reply.created_at,
      }
    })
  })

  router.post('/api/board/posts/:id/upvote', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const postId = req.params.id
    const userId = req.currentUser.id
    try {
      const { data: post, error: postError } = await supabase
        .from('board_posts')
        .select('id')
        .eq('id', postId)
        .is('deleted_at', null)
        .maybeSingle()
      if (postError) throw postError
      if (!post) return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })
      res.json(
        await toggleUpvote({
          supabase,
          table: 'board_upvotes',
          refColumn: 'post_id',
          refId: postId,
          userId,
          now: new Date().toISOString(),
          syncCount: () => communityCounters.syncBoardPostUpvotes(postId),
        }),
      )
    } catch (error) {
      return respondBoardDbError(res, error)
    }
  })

  // Owner-only edit of a post's title/body (issue #7)
  router.patch('/api/board/posts/:id', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const postId = req.params.id
    const userId = req.currentUser.id
    const title = String(req.body.title ?? '').trim()
    const body = String(req.body.body ?? '').trim()

    const limits = validateBoardPost({ title, body })
    if (!limits.ok) return badRequest(res, limits.message)

    const profanityCheck = assertBoardPostTextAllowed(title, body)
    if (!profanityCheck.ok) {
      return res.status(400).json({ error: { message: profanityCheck.message, status: 400 } })
    }

    const editedAt = new Date().toISOString()
    let { data, error } = await supabase
      .from('board_posts')
      .update({ title, body, edited_at: editedAt, updated_at: editedAt })
      .eq('id', postId)
      .eq('user_id', userId)
      // A taken-down post is not editable; DELETE and reply already scope this way,
      // and without it the admin restore view showed content edited after removal (#196).
      .is('deleted_at', null)
      .select('*')

    // Retry without edited_at when the optional column migration hasn't run yet
    if (error && (error.code === 'PGRST204' || error.code === '42703')) {
      ;({ data, error } = await supabase
        .from('board_posts')
        .update({ title, body, updated_at: editedAt })
        .eq('id', postId)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .select('*'))
    }

    if (error) return respondBoardDbError(res, error)
    if (!data?.length) {
      return res.status(404).json({
        error: { message: 'Post not found or you can only edit your own posts.', status: 404 },
      })
    }

    const post = data[0]
    res.json({
      post: {
        id: post.id,
        title: post.title,
        body: post.body,
        editedTime: post.edited_at || editedAt,
      },
    })
  })

  router.delete('/api/board/posts/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const postId = req.params.id
    const userId = req.currentUser.id
    // Soft delete: hide the post (set deleted_at). Its replies stay attached and
    // reappear if an admin restores it; a hard delete (admin) cascades them.
    // Owner or admin: admins take down live posts from reports (issue #195).
    const query = supabase
      .from('board_posts')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', postId)
      .is('deleted_at', null)
    const { data, error } = await ownerOrAdminScope(query, { userId, isAdmin: isUserAdmin(req.currentUser) }).select('id')
    if (error) return respondBoardDbError(res, error)
    if (!data?.length) {
      return res.status(404).json({
        error: { message: 'Post not found or you can only delete your own posts.', status: 404 },
      })
    }
    res.status(204).end()
  })

  return router
}
