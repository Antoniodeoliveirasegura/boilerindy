import express from 'express'
import { excludeAuthors, loadBlockedIds } from '../blocks.mjs'
import { assertBoardPostTextAllowed } from '../boardProfanity.mjs'
import { DB_FEATURES, respondDbError, respondSchemaMissing } from '../dbErrors.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { isMissingColumnError, isUuid, ownerOrAdminScope, selectLiveRows } from '../moderation.mjs'
import { joinOutcomeToResponse, joinStudyGroup } from '../studyGroupJoin.mjs'
import {
  coursesFromClassItems,
  normalizeCourseCode,
  STUDY_SOFT_DELETE_SQL_FILE,
  validateStudyGroupInput,
} from '../studyGroups.mjs'

// Study Group Finder (issue #33): per-course groups from synced schedules.
// Privacy is opt-in (default off); only opted-in users count as classmates.
// Requires db/supabase-study-groups.sql, and for the delete route
// db/supabase-study-groups-soft-delete.sql. Moved out of server.mjs as a
// feature router (issue #191) with the handlers unchanged.

const STUDY_SOFT_DELETE_DB = {
  ...DB_FEATURES.study_groups,
  label: 'Removing study groups',
  sqlFile: STUDY_SOFT_DELETE_SQL_FILE,
}

function respondStudyDbError(res, err) {
  // Checked first so the log names the soft-delete migration rather than the
  // base study-groups file; the client sees study_groups_schema_missing either way.
  if (isMissingColumnError(err, 'deleted_at')) return respondSchemaMissing(res, STUDY_SOFT_DELETE_DB, err)
  return respondDbError(res, err, DB_FEATURES.study_groups)
}

function mapStudyGroupRow(row, userId, memberCounts, myGroupIds) {
  return {
    id: row.id,
    courseCode: row.course_code,
    title: row.title,
    description: row.description || '',
    meetingInfo: row.meeting_info || '',
    capacity: row.capacity ?? null,
    memberCount: memberCounts.get(row.id) || 0,
    joinedByMe: myGroupIds.has(row.id),
    isMine: row.creator_id === userId,
    createdAt: row.created_at,
  }
}

/**
 * The Study Group Finder routes, mounted by server.mjs where they used to be.
 * Paths stay absolute (`/api/study-groups`, `/api/me/study-groups`) so
 * docs/RATE_LIMITS.md and its guard test read the same whether a route lives
 * here or in server.mjs.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase             the Supabase client
 * @param {Function} deps.requireAuth          loads req.currentUser or answers 401
 * @param {Function} deps.isUserAdmin          true for an admin: lets the delete past the creator filter
 * @param {Function} deps.getClassItemsForUser the user's class calendar items (stays in server.mjs until the me router)
 * @param {Function} deps.boardWriteRateLimit  the community write limiter (create, join, leave)
 * @param {Function} deps.userWriteRateLimit   the shared per-user write limiter (opt-in, delete)
 */
export function createStudyGroupsRouter({ supabase, requireAuth, isUserAdmin, getClassItemsForUser, boardWriteRateLimit, userWriteRateLimit }) {
  const router = express.Router()

  async function loadStudyMembership(groupIds, userId) {
    const memberCounts = new Map()
    const myGroupIds = new Set()
    if (groupIds.length) {
      const { data: members } = await supabase
        .from('study_group_members')
        .select('group_id, user_id')
        .in('group_id', groupIds)
      for (const m of members || []) {
        memberCounts.set(m.group_id, (memberCounts.get(m.group_id) || 0) + 1)
        if (m.user_id === userId) myGroupIds.add(m.group_id)
      }
    }
    return { memberCounts, myGroupIds }
  }

  // The user's detected courses + opt-in status + classmate counts (opted-in only).
  router.get('/api/me/study-groups/courses', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const optIn = Boolean(req.currentUser.study_groups_opt_in)
      const { items } = await getClassItemsForUser(userId, { term: 'auto', limit: 200 })
      const courses = coursesFromClassItems(items)
      const counts = new Map()
      if (courses.length) {
        const { data } = await supabase
          .from('study_group_courses')
          .select('course_code, user_id')
          .in('course_code', courses)
        for (const row of data || []) {
          if (row.user_id === userId) continue // never count yourself
          counts.set(row.course_code, (counts.get(row.course_code) || 0) + 1)
        }
      }
      res.json({ optIn, courses: courses.map((c) => ({ code: c, classmateCount: counts.get(c) || 0 })) })
    } catch (e) {
      return respondStudyDbError(res, e)
    }
  })

  // Toggle opt-in; on opt-in, snapshot the user's course codes for classmate counts.
  router.patch('/api/me/study-groups/opt-in', userWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const optIn = req.body?.optIn === true || req.body?.optIn === 'true'
    try {
      const { error } = await supabase.from('users').update({ study_groups_opt_in: optIn }).eq('id', userId)
      if (error) throw error
      await supabase.from('study_group_courses').delete().eq('user_id', userId)
      if (optIn) {
        const { items } = await getClassItemsForUser(userId, { term: 'auto', limit: 200 })
        const courses = coursesFromClassItems(items)
        if (courses.length) {
          await supabase.from('study_group_courses').insert(courses.map((c) => ({ user_id: userId, course_code: c })))
        }
      }
      res.json({ ok: true, optIn })
    } catch (e) {
      return respondStudyDbError(res, e)
    }
  })

  // Groups the current user belongs to.
  router.get('/api/me/study-groups', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const { data: mem, error } = await supabase
        .from('study_group_members')
        .select('group_id')
        .eq('user_id', userId)
      if (error) throw error
      const ids = (mem || []).map((m) => m.group_id)
      if (!ids.length) return res.json({ groups: [] })
      // Taken-down groups keep their member rows (so a restore brings them back)
      // but must not show up here, and neither does a group whose creator is on
      // either side of a block with the caller (#192).
      const blocked = await loadBlockedIds(supabase, userId)
      const { data: groups } = await selectLiveRows((liveOnly) => {
        const query = excludeAuthors(supabase.from('study_groups').select('*').in('id', ids), 'creator_id', blocked)
        return liveOnly ? query.is('deleted_at', null) : query
      })
      const { memberCounts, myGroupIds } = await loadStudyMembership(ids, userId)
      res.json({ groups: (groups || []).map((g) => mapStudyGroupRow(g, userId, memberCounts, myGroupIds)) })
    } catch (e) {
      return respondStudyDbError(res, e)
    }
  })

  // List groups for a course.
  router.get('/api/study-groups', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const course = normalizeCourseCode(req.query.course)
    if (!course) return res.status(400).json({ error: { message: 'A valid course code is required.', status: 400 } })
    try {
      // Groups whose creator is on either side of a block with the caller are left out (#192).
      const blocked = await loadBlockedIds(supabase, userId)
      const { data: groups, error } = await selectLiveRows((liveOnly) => {
        let query = excludeAuthors(supabase.from('study_groups').select('*').eq('course_code', course), 'creator_id', blocked)
        if (liveOnly) query = query.is('deleted_at', null)
        return query.order('created_at', { ascending: false }).limit(100)
      })
      if (error) throw error
      const ids = (groups || []).map((g) => g.id)
      const { memberCounts, myGroupIds } = await loadStudyMembership(ids, userId)
      res.json({ courseCode: course, groups: (groups || []).map((g) => mapStudyGroupRow(g, userId, memberCounts, myGroupIds)) })
    } catch (e) {
      return respondStudyDbError(res, e)
    }
  })

  // Create a group (creator auto-joins).
  router.post('/api/study-groups', boardWriteRateLimit, requireAuth, async (req, res) => {
    const { value, error: invalid } = validateStudyGroupInput(req.body || {})
    if (invalid) return res.status(400).json({ error: { message: invalid, status: 400 } })
    const profanity = assertBoardPostTextAllowed(value.title, value.description)
    if (!profanity.ok) return res.status(400).json({ error: { message: profanity.message, status: 400 } })
    try {
      const { data, error } = await supabase
        .from('study_groups')
        .insert({ creator_id: req.currentUser.id, ...value })
        .select('*')
        .single()
      if (error) throw error
      await supabase.from('study_group_members').insert({ group_id: data.id, user_id: req.currentUser.id, joined_at: new Date().toISOString() })
      res.status(201).json({
        group: mapStudyGroupRow(data, req.currentUser.id, new Map([[data.id, 1]]), new Set([data.id])),
      })
    } catch (e) {
      return respondStudyDbError(res, e)
    }
  })

  // Join a group (respects capacity).
  router.post('/api/study-groups/:id/join', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const groupId = req.params.id
    try {
      // maybeSingle so a missing or taken-down group is the 404 below, not a 500.
      const { data: group, error: gErr } = await selectLiveRows((liveOnly) => {
        let query = supabase.from('study_groups').select('id, capacity').eq('id', groupId)
        if (liveOnly) query = query.is('deleted_at', null)
        return query.maybeSingle()
      })
      if (gErr) throw gErr
      if (!group) return res.status(404).json({ error: { message: 'Group not found.', status: 404 } })

      // Counting members here and inserting after let two students take the same
      // last seat (#207). src/studyGroupJoin.mjs prefers a Postgres function that
      // locks the group and does count, check and insert in one transaction, and
      // falls back to the old read-then-insert until that migration runs.
      const result = await joinStudyGroup(supabase, {
        groupId,
        userId,
        capacity: group.capacity,
        now: new Date().toISOString(),
      })
      if (result.error) throw result.error
      const { status, body } = joinOutcomeToResponse(result)
      res.status(status).json(body)
    } catch (e) {
      return respondStudyDbError(res, e)
    }
  })

  // Leave a group.
  router.post('/api/study-groups/:id/leave', boardWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const { error } = await supabase
        .from('study_group_members')
        .delete()
        .eq('group_id', req.params.id)
        .eq('user_id', userId)
      if (error) throw error
      res.json({ ok: true })
    } catch (e) {
      return respondStudyDbError(res, e)
    }
  })

  // Delete a group - its creator or an admin (issue #195). Soft delete: the group
  // leaves every list, but its members stay attached so an admin restore from the
  // moderation view brings it back whole. Answers 503 (respondStudyDbError) until
  // db/supabase-study-groups-soft-delete.sql adds the deleted_at column.
  router.delete('/api/study-groups/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const groupId = req.params.id
    if (!isUuid(groupId)) {
      return res.status(404).json({ error: { message: 'Group not found or not yours.', status: 404 } })
    }
    try {
      const query = supabase
        .from('study_groups')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', groupId)
        .is('deleted_at', null)
      const { data, error } = await ownerOrAdminScope(query, {
        userId: req.currentUser.id,
        isAdmin: isUserAdmin(req.currentUser),
        ownerColumn: 'creator_id',
      }).select('id')
      if (error) throw error
      if (!data?.length) return res.status(404).json({ error: { message: 'Group not found or not yours.', status: 404 } })
      res.status(204).end()
    } catch (e) {
      return respondStudyDbError(res, e)
    }
  })

  return router
}
