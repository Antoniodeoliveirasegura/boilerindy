import express from 'express'
import { loadBlockedIds } from '../blocks.mjs'
import { assertBoardPostTextAllowed } from '../boardProfanity.mjs'
import { DB_FEATURES, respondDbError } from '../dbErrors.mjs'
import { mapMatchCard, rankMatches, sendConnectionRequest, validateProfileInput } from '../friendMatching.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { coursesFromClassItems } from '../studyGroups.mjs'

// Friend Matching (issue #17): connect students who share courses. Privacy
// is opt-in (discoverable, default off); before a request is accepted only the
// display name, interests and shared-course count are exposed. Requires
// db/supabase-friend-matching.sql. Moved out of server.mjs as a feature router
// (issue #191) with the handlers unchanged.

function respondFriendsDbError(res, err) {
  return respondDbError(res, err, DB_FEATURES.friends)
}

/**
 * The Friend Matching routes, mounted by server.mjs where they used to be.
 * Paths stay absolute (`/api/me/matches`, `/api/connections`) so
 * docs/RATE_LIMITS.md and its guard test read the same whether a route
 * lives here or in server.mjs. No route here has an admin gate.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase             the Supabase client
 * @param {Function} deps.requireAuth          loads req.currentUser or answers 401
 * @param {Function} deps.getClassItemsForUser the user's class calendar items (from src/calendarReads.mjs, built in server.mjs)
 * @param {Function} deps.boardWriteRateLimit  the community write limiter (profile, connection request)
 * @param {Function} deps.userWriteRateLimit   the shared per-user write limiter (accept or decline)
 */
export function createFriendsRouter({ supabase, requireAuth, getClassItemsForUser, boardWriteRateLimit, userWriteRateLimit }) {
  const router = express.Router()

  // My profile + discoverable status.
  router.get('/api/me/profile-card', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const { data, error } = await supabase.from('user_profiles').select('*').eq('user_id', userId).maybeSingle()
      if (error) throw error
      res.json({
        bio: data?.bio || '',
        interests: Array.isArray(data?.interests) ? data.interests : [],
        discoverable: Boolean(data?.discoverable),
      })
    } catch (e) {
      return respondFriendsDbError(res, e)
    }
  })

  // Update profile; on discoverable=true, snapshot my course codes for matching.
  router.put('/api/me/profile-card', boardWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { value, error: invalid } = validateProfileInput(req.body || {})
    if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })
    const profanity = assertBoardPostTextAllowed(value.bio, value.interests.join(' '))
    if (!profanity.ok) return res.status(400).json({ error: { message: profanity.message, status: 400 } })
    try {
      const { error } = await supabase
        .from('user_profiles')
        .upsert({ user_id: userId, ...value, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      if (error) throw error
      await supabase.from('friend_match_courses').delete().eq('user_id', userId)
      if (value.discoverable) {
        const { items } = await getClassItemsForUser(userId, { term: 'auto', limit: 200 })
        const courses = coursesFromClassItems(items)
        if (courses.length) {
          await supabase.from('friend_match_courses').insert(courses.map((c) => ({ user_id: userId, course_code: c })))
        }
      }
      res.json({ ok: true, ...value })
    } catch (e) {
      return respondFriendsDbError(res, e)
    }
  })

  // Discoverable users sharing >=1 course, ranked by overlap. No email/schedule.
  router.get('/api/me/matches', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const me = await supabase.from('user_profiles').select('discoverable').eq('user_id', userId).maybeSingle()
      if (!me.data?.discoverable) return res.json({ matches: [], discoverable: false })

      const { items } = await getClassItemsForUser(userId, { term: 'auto', limit: 200 })
      const myCourses = new Set(coursesFromClassItems(items))
      if (myCourses.size === 0) return res.json({ matches: [], discoverable: true })

      // Candidate users who share at least one of my courses (excluding me).
      const { data: courseRows, error: cErr } = await supabase
        .from('friend_match_courses')
        .select('user_id, course_code')
        .in('course_code', [...myCourses])
      if (cErr) throw cErr
      const byUser = new Map()
      for (const row of courseRows || []) {
        if (row.user_id === userId) continue
        if (!byUser.has(row.user_id)) byUser.set(row.user_id, [])
        byUser.get(row.user_id).push(row.course_code)
      }
      if (byUser.size === 0) return res.json({ matches: [], discoverable: true })

      // Exclude users with an existing connection (any direction/status).
      const { data: conns } = await supabase
        .from('connections')
        .select('requester_id, addressee_id')
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      const connected = new Set()
      for (const c of conns || []) {
        connected.add(c.requester_id === userId ? c.addressee_id : c.requester_id)
      }
      // Nor anyone on either side of a block (#192).
      const blocked = await loadBlockedIds(supabase, userId)

      const candidates = [...byUser.entries()]
        .filter(([uid]) => !connected.has(uid) && !blocked.has(uid))
        .map(([uid, courses]) => ({ userId: uid, courses }))
      const ranked = rankMatches(myCourses, candidates)
      if (ranked.length === 0) return res.json({ matches: [], discoverable: true })

      // Hydrate names + interests for the ranked candidates (discoverable only).
      const ids = ranked.map((r) => r.userId)
      const { data: profiles } = await supabase.from('user_profiles').select('user_id, interests, discoverable').in('user_id', ids)
      const { data: users } = await supabase.from('users').select('id, display_name').in('id', ids)
      const profById = new Map((profiles || []).map((p) => [p.user_id, p]))
      const userById = new Map((users || []).map((u) => [u.id, u]))

      const matches = ranked
        .filter((r) => profById.get(r.userId)?.discoverable)
        .map((r) => {
          const card = mapMatchCard(
            { id: r.userId, display_name: userById.get(r.userId)?.display_name, interests: profById.get(r.userId)?.interests },
            r.sharedCount,
          )
          return { ...card, sharedCourses: r.sharedCourses }
        })
      res.json({ matches, discoverable: true })
    } catch (e) {
      return respondFriendsDbError(res, e)
    }
  })

  // Send a connection request (dropped silently if the addressee declined before,
  // is not discoverable, does not exist, or a block stands between the two, #192).
  // The gate lives in sendConnectionRequest (src/friendMatching.mjs) so it is
  // tested (#203).
  router.post('/api/connections', boardWriteRateLimit, requireAuth, async (req, res) => {
    try {
      const blocked = await loadBlockedIds(supabase, req.currentUser.id)
      const out = await sendConnectionRequest(supabase, req.currentUser.id, req.body?.addresseeId, { nowIso: () => new Date().toISOString(), blocked })
      return res.status(out.status).json(out.body)
    } catch (e) {
      return respondFriendsDbError(res, e)
    }
  })

  // Accept or decline an incoming request.
  router.patch('/api/connections/:requesterId', userWriteRateLimit, requireIdParam('requesterId'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const requesterId = req.params.requesterId
    const action = String(req.body?.action || '').trim()
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: { message: 'Action must be accept or decline.', status: 400 } })
    }
    try {
      const { data, error } = await supabase
        .from('connections')
        .update({ status: action === 'accept' ? 'accepted' : 'declined' })
        .eq('requester_id', requesterId)
        .eq('addressee_id', userId)
        .eq('status', 'pending')
        .select('requester_id')
      if (error) throw error
      if (!data?.length) return res.status(404).json({ error: { message: 'No pending request from that user.', status: 404 } })
      res.json({ ok: true, status: action === 'accept' ? 'accepted' : 'declined' })
    } catch (e) {
      return respondFriendsDbError(res, e)
    }
  })

  // My connections: accepted (with contact email) + incoming pending requests.
  router.get('/api/me/connections', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const { data: conns, error } = await supabase
        .from('connections')
        .select('requester_id, addressee_id, status')
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      if (error) throw error

      // A block deletes the pair's rows; one that slipped in around it stays hidden (#192).
      const blocked = await loadBlockedIds(supabase, userId)
      const accepted = []
      const incoming = []
      const otherIds = new Set()
      for (const c of conns || []) {
        const other = c.requester_id === userId ? c.addressee_id : c.requester_id
        if (blocked.has(other)) continue
        otherIds.add(other)
        if (c.status === 'accepted') accepted.push({ userId: other })
        else if (c.status === 'pending' && c.addressee_id === userId) incoming.push({ userId: c.requester_id })
      }
      const { data: users } = otherIds.size
        ? await supabase.from('users').select('id, display_name, email').in('id', [...otherIds])
        : { data: [] }
      const userById = new Map((users || []).map((u) => [u.id, u]))
      // Accepted connections may see the Purdue email for contact; pending may not.
      const acctOut = accepted.map((a) => ({
        userId: a.userId,
        displayName: userById.get(a.userId)?.display_name || 'Student',
        email: userById.get(a.userId)?.email || null,
      }))
      const inOut = incoming.map((a) => ({
        userId: a.userId,
        displayName: userById.get(a.userId)?.display_name || 'Student',
      }))
      res.json({ accepted: acctOut, incoming: inOut })
    } catch (e) {
      return respondFriendsDbError(res, e)
    }
  })

  return router
}
