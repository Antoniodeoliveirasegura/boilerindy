import express from 'express'
import { categoryListFromCounts, loadCalendarCategoryCounts } from '../calendarCategoryCounts.mjs'
import { badRequest, respondRouteError } from '../dbErrors.mjs'
import { getProgram } from '../degreePrograms.mjs'
import {
  LETTER_GRADES,
  MAX_COURSE_NAME,
  MAX_TERM_NAME,
  MAX_CREDIT_HOURS,
  DEFAULT_CREDIT_HOURS,
  DEFAULT_TERM,
} from '../gradeTracker.mjs'
import { requireIdParam } from '../httpGuards.mjs'
import { mapManualTaskRow, parseManualTaskCreate, parseManualTaskUpdate } from '../manualTasks.mjs'
import { normalizeScheduleOverrides } from '../scheduleOverrides.mjs'
import {
  GRADES_CAP_MESSAGE,
  MANUAL_TASKS_CAP_MESSAGE,
  MAX_GRADES,
  MAX_MANUAL_TASKS,
  capCheck,
} from '../userWriteCaps.mjs'

// The student's own records: the calendar and events reads with the category
// counts, the task list (calendar items marked done, and to-dos added by hand),
// the grade tracker (issue #10), the degree planner's major (issue #18) and the
// schedule edits. Moved out of server.mjs as a feature router (issue #191) with
// the handlers unchanged apart from nowIso() inlined. The calendar readers come
// from src/calendarReads.mjs: server.mjs builds them once and hands them to this
// router and to the assistant, study groups and friends routers.

// Ascending order plus a row limit means an unbounded read returns the OLDEST
// rows, so once a user accumulates more than `limit` historical items the
// upcoming ones fall off the end and the page renders empty. Both of these
// routes serve forward-looking views, so they default to a recent window; a
// client that wants deeper history passes an explicit ?from=.
const CALENDAR_DEFAULT_LOOKBACK_DAYS = 14
function defaultCalendarFrom() {
  return new Date(Date.now() - CALENDAR_DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

// ── Tasks: mark calendar rows done + user-created dated tasks (see db/supabase-user-tasks.sql) ──
// Manual task rows are parsed and mapped by src/manualTasks.mjs (issue #216).

// Runs on every Assignments and dashboard load, so both reads are bounded
// (issue #198) instead of returning every row the user ever wrote:
// - completions from the last TASK_COMPLETIONS_LOOKBACK_DAYS only. Older ones
//   belong to calendar items that are no longer shown (Assignments lists items
//   from 14 days back), so dropping them changes nothing on screen.
// - manual tasks that are still open, or were completed in the last
//   MANUAL_TASKS_DONE_LOOKBACK_DAYS.
// Each read also caps at TASK_META_ROW_LIMIT, the PostgREST max-rows, so the
// bound is explicit rather than a silent truncation.
const TASK_COMPLETIONS_LOOKBACK_DAYS = 120
const MANUAL_TASKS_DONE_LOOKBACK_DAYS = 60
const TASK_META_ROW_LIMIT = 1000

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// ---- Grade tracker (issue #10) -------------------------------------------
const LETTER_GRADE_SET = new Set(LETTER_GRADES)

function mapGradeRow(row) {
  return {
    id: row.id,
    courseName: row.course_name,
    term: row.term,
    creditHours: typeof row.credit_hours === 'string' ? Number(row.credit_hours) : row.credit_hours,
    letterGrade: row.letter_grade,
  }
}

// Validate + coerce a request body into DB columns. Returns { value } on success
// or { error } with a user-facing message. `partial` allows missing fields
// (PATCH); a full insert requires courseName + letterGrade.
function parseGradeBody(body, { partial } = {}) {
  const updates = {}
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k)

  if (has('courseName') || !partial) {
    const name = String(body?.courseName ?? '').trim()
    if (!name || name.length > MAX_COURSE_NAME) {
      return { error: `Course name is required (max ${MAX_COURSE_NAME} characters)` }
    }
    updates.course_name = name
  }
  if (has('letterGrade') || !partial) {
    const letter = String(body?.letterGrade ?? '').trim()
    if (!LETTER_GRADE_SET.has(letter)) {
      return { error: 'A valid letter grade is required' }
    }
    updates.letter_grade = letter
  }
  if (has('term') || !partial) {
    const term = String(body?.term ?? '').trim().slice(0, MAX_TERM_NAME) || DEFAULT_TERM
    updates.term = term
  }
  if (has('creditHours') || !partial) {
    const n = Number(body?.creditHours ?? DEFAULT_CREDIT_HOURS)
    if (!Number.isFinite(n) || n < 0 || n > MAX_CREDIT_HOURS) {
      return { error: `Credit hours must be between 0 and ${MAX_CREDIT_HOURS}` }
    }
    updates.credit_hours = Math.round(n * 100) / 100
  }
  return { value: updates }
}

/**
 * The calendar, task, grade, degree and schedule-edit routes, mounted by
 * server.mjs where they used to be. Paths stay absolute (`/api/me/grades`) so
 * docs/RATE_LIMITS.md and its guard test read the same whether a route lives
 * here or in server.mjs. Every route needs a session; none has an admin gate.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase              the Supabase client
 * @param {Function} deps.requireAuth           loads req.currentUser or answers 401
 * @param {Function} deps.userWriteRateLimit    the shared per-user write limiter, on the nine writes
 * @param {Function} deps.listCalendarItems     the calendar reader (from src/calendarReads.mjs, built in server.mjs)
 * @param {Function} deps.getClassItemsForUser  the class reader (from src/calendarReads.mjs, built in server.mjs)
 * @param {Function} deps.readScheduleOverrides the schedule edits reader (from src/calendarReads.mjs, built in server.mjs)
 */
export function createMeRouter({ supabase, requireAuth, userWriteRateLimit, listCalendarItems, getClassItemsForUser, readScheduleOverrides }) {
  const router = express.Router()

  router.get('/api/me/calendar', requireAuth, async (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : null
    const categories = typeof req.query.categories === 'string' ? req.query.categories.split(',').filter(Boolean) : null
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100
    const from = typeof req.query.from === 'string' ? req.query.from : defaultCalendarFrom()
    res.json({ items: await listCalendarItems(req.currentUser.id, { category, categories, limit, order: 'asc', from }) })
  })

  // Counted in Postgres by calendar_category_counts (db/supabase-calendar-category-counts.sql)
  // instead of streaming every row to count in JS (issue #198); until that
  // migration runs, loadCalendarCategoryCounts falls back to the JS count.
  router.get('/api/me/calendar/categories', requireAuth, async (req, res) => {
    const { counts, error } = await loadCalendarCategoryCounts(supabase, req.currentUser.id)

    if (error) {
      return res.json({ categories: [] })
    }

    res.json({ categories: categoryListFromCounts(counts) })
  })

  router.get('/api/me/tasks/meta', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const [compRes, manualRes] = await Promise.all([
        supabase
          .from('user_task_completions')
          .select('calendar_item_id, completed_at')
          .eq('user_id', userId)
          .gte('completed_at', daysAgoIso(TASK_COMPLETIONS_LOOKBACK_DAYS))
          .order('completed_at', { ascending: false })
          .limit(TASK_META_ROW_LIMIT),
        supabase
          .from('user_manual_tasks')
          .select('*')
          .eq('user_id', userId)
          .or(`completed_at.is.null,completed_at.gte.${daysAgoIso(MANUAL_TASKS_DONE_LOOKBACK_DAYS)}`)
          .order('due_at', { ascending: true })
          .limit(TASK_META_ROW_LIMIT),
      ])
      if (compRes.error) throw compRes.error
      if (manualRes.error) throw manualRes.error
      res.json({
        completions: compRes.data || [],
        manualTasks: (manualRes.data || []).map(mapManualTaskRow),
      })
    } catch (e) {
      console.error('GET /api/me/tasks/meta:', e?.message || e)
      res.json({ completions: [], manualTasks: [], unavailable: true })
    }
  })

  router.post('/api/me/tasks/calendar/complete', userWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { calendarItemId, completed } = req.body || {}
    if (!calendarItemId || typeof completed !== 'boolean') {
      return badRequest(res, 'calendarItemId and completed (boolean) required')
    }
    const { data: row, error: findErr } = await supabase
      .from('calendar_items')
      .select('id')
      .eq('id', calendarItemId)
      .eq('user_id', userId)
      .maybeSingle()
    if (findErr || !row) {
      return res.status(404).json({ error: { message: 'Calendar item not found' } })
    }
    try {
      if (completed) {
        const { error: insErr } = await supabase.from('user_task_completions').insert({
          user_id: userId,
          calendar_item_id: calendarItemId,
          completed_at: new Date().toISOString(),
        })
        if (insErr) {
          if (insErr.code === '23505') {
            const { error: updErr } = await supabase
              .from('user_task_completions')
              .update({ completed_at: new Date().toISOString() })
              .eq('user_id', userId)
              .eq('calendar_item_id', calendarItemId)
            if (updErr) throw updErr
          } else {
            throw insErr
          }
        }
      } else {
        const { error } = await supabase
          .from('user_task_completions')
          .delete()
          .eq('user_id', userId)
          .eq('calendar_item_id', calendarItemId)
        if (error) throw error
      }
      res.json({ ok: true })
    } catch (e) {
      respondRouteError(res, e, { label: 'POST /api/me/tasks/calendar/complete', fallback: 'Could not update completion' })
    }
  })

  router.post('/api/me/tasks/manual', userWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    // dueAt is optional (db/supabase-manual-task-due-optional.sql drops the NOT NULL). The mobile
    // client creates undated to-dos from a title alone, which this used to reject outright. A
    // dueAt that IS supplied still has to be a parseable timestamp, so a malformed date is a 400
    // rather than being silently stored as no deadline at all.
    const parsed = parseManualTaskCreate(req.body)
    if (!parsed.ok) return badRequest(res, parsed.message)
    try {
      const countResult = await supabase
        .from('user_manual_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
      const cap = capCheck(countResult, MAX_MANUAL_TASKS)
      if (cap.failure) console.error('POST /api/me/tasks/manual:', cap.failure, countResult.error)
      if (cap.blocked) {
        return res.status(409).json({ error: { message: MANUAL_TASKS_CAP_MESSAGE, status: 409 } })
      }
      const { data, error } = await supabase
        .from('user_manual_tasks')
        .insert({
          user_id: userId,
          title: parsed.row.title,
          due_at: parsed.row.due_at,
        })
        .select()
        .single()
      if (error) throw error
      res.json({ task: mapManualTaskRow(data) })
    } catch (e) {
      respondRouteError(res, e, { label: 'POST /api/me/tasks/manual', fallback: 'Could not create task' })
    }
  })

  router.patch('/api/me/tasks/manual/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { id } = req.params
    // An absent dueAt leaves the deadline alone; null or '' clears it (issue #216). A malformed
    // value is a 400 like POST instead of being dropped while the other fields save.
    const parsed = parseManualTaskUpdate(req.body, { now: new Date().toISOString() })
    if (!parsed.ok) return badRequest(res, parsed.message)
    try {
      const { data, error } = await supabase
        .from('user_manual_tasks')
        .update(parsed.updates)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        // maybeSingle: .single() answers PGRST116 for zero rows, which made the
        // 404 below unreachable and sent someone else's id down the 500 path (#196).
        .maybeSingle()
      if (error) throw error
      if (!data) return res.status(404).json({ error: { message: 'Task not found.', status: 404 } })
      res.json({ task: mapManualTaskRow(data) })
    } catch (e) {
      respondRouteError(res, e, { label: 'PATCH /api/me/tasks/manual', fallback: 'Could not update task' })
    }
  })

  router.delete('/api/me/tasks/manual/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { id } = req.params
    try {
      const { error } = await supabase.from('user_manual_tasks').delete().eq('id', id).eq('user_id', userId)
      if (error) throw error
      res.json({ ok: true })
    } catch (e) {
      respondRouteError(res, e, { label: 'DELETE /api/me/tasks/manual', fallback: 'Could not delete task' })
    }
  })

  router.get('/api/me/grades', requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    try {
      const { data, error } = await supabase
        .from('user_grades')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
      if (error) throw error
      res.json({ grades: (data || []).map(mapGradeRow) })
    } catch (e) {
      console.error('GET /api/me/grades:', e?.message || e)
      res.json({ grades: [], unavailable: true })
    }
  })

  router.post('/api/me/grades', userWriteRateLimit, requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { value, error: invalid } = parseGradeBody(req.body || {}, { partial: false })
    if (invalid) return badRequest(res, invalid)
    try {
      const countResult = await supabase
        .from('user_grades')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
      const cap = capCheck(countResult, MAX_GRADES)
      if (cap.failure) console.error('POST /api/me/grades:', cap.failure, countResult.error)
      if (cap.blocked) {
        return res.status(409).json({ error: { message: GRADES_CAP_MESSAGE, status: 409 } })
      }
      const { data, error } = await supabase
        .from('user_grades')
        .insert({ user_id: userId, ...value })
        .select()
        .single()
      if (error) throw error
      res.json({ grade: mapGradeRow(data) })
    } catch (e) {
      respondRouteError(res, e, { label: 'POST /api/me/grades', fallback: 'Could not save course' })
    }
  })

  router.patch('/api/me/grades/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { id } = req.params
    const { value, error: invalid } = parseGradeBody(req.body || {}, { partial: true })
    if (invalid) return badRequest(res, invalid)
    if (Object.keys(value).length === 0) {
      return badRequest(res, 'No valid fields to update')
    }
    try {
      const { data, error } = await supabase
        .from('user_grades')
        .update(value)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .maybeSingle()
      if (error) throw error
      if (!data) return res.status(404).json({ error: { message: 'Course not found.', status: 404 } })
      res.json({ grade: mapGradeRow(data) })
    } catch (e) {
      respondRouteError(res, e, { label: 'PATCH /api/me/grades/:id', fallback: 'Could not update course' })
    }
  })

  router.delete('/api/me/grades/:id', userWriteRateLimit, requireIdParam('id'), requireAuth, async (req, res) => {
    const userId = req.currentUser.id
    const { id } = req.params
    try {
      const { error } = await supabase.from('user_grades').delete().eq('id', id).eq('user_id', userId)
      if (error) throw error
      res.json({ ok: true })
    } catch (e) {
      respondRouteError(res, e, { label: 'DELETE /api/me/grades/:id', fallback: 'Could not delete course' })
    }
  })

  // Selected major for the degree planner (issue #18). Validated against the
  // degreePrograms catalogue; null clears it.
  router.get('/api/me/degree', requireAuth, async (req, res) => {
    res.json({ major: req.currentUser.major ?? null })
  })

  router.put('/api/me/degree', userWriteRateLimit, requireAuth, async (req, res) => {
    const raw = req.body?.major
    const major = raw == null || raw === '' ? null : String(raw)
    if (major !== null && !getProgram(major)) {
      return badRequest(res, 'Unknown major')
    }
    const { error } = await supabase.from('users').update({ major }).eq('id', req.currentUser.id)
    if (error) {
      console.error('PUT /api/me/degree:', error.message)
      return res.status(500).json({ error: { message: 'Could not save your major.' } })
    }
    res.json({ major })
  })

  // ---- Schedule overrides --------------------------------------------------
  // Hidden / edited / manually added class meetings. Previously localStorage only,
  // so they were lost on a new device and invisible to the campus assistant.
  // Stored as one JSONB document because the client always reads and writes the
  // whole state at once.
  router.get('/api/me/schedule-overrides', requireAuth, async (req, res) => {
    try {
      res.json({ overrides: await readScheduleOverrides(req.currentUser.id) })
    } catch (e) {
      console.error('GET /api/me/schedule-overrides:', e?.message || e)
      // The client keeps a local copy, so an unavailable table degrades to
      // "no server state yet" rather than wiping the student's edits.
      res.json({ overrides: { series: {}, manual: [] }, unavailable: true })
    }
  })

  router.put('/api/me/schedule-overrides', userWriteRateLimit, requireAuth, async (req, res) => {
    const overrides = normalizeScheduleOverrides(req.body?.overrides)
    try {
      const { error } = await supabase
        .from('user_schedule_overrides')
        .upsert(
          {
            user_id: req.currentUser.id,
            series: overrides.series,
            manual: overrides.manual,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' },
        )
      if (error) throw error
      res.json({ overrides })
    } catch (e) {
      console.error('PUT /api/me/schedule-overrides:', e?.message || e)
      res.status(500).json({ error: { message: 'Could not save schedule changes.' } })
    }
  })

  router.get('/api/me/classes', requireAuth, async (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20
    const term = typeof req.query.term === 'string' ? req.query.term : 'auto'
    const mode = typeof req.query.mode === 'string' ? req.query.mode : 'display'
    const data = await getClassItemsForUser(req.currentUser.id, { limit, term, mode })
    res.json(data)
  })

  router.get('/api/me/events', requireAuth, async (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20
    const from = typeof req.query.from === 'string' ? req.query.from : defaultCalendarFrom()
    res.json({ items: await listCalendarItems(req.currentUser.id, { category: 'event', limit, order: 'asc', from }) })
  })

  return router
}
