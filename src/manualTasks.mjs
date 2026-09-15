// Manual tasks (issue #216). POST /api/me/tasks/manual and PATCH
// /api/me/tasks/manual/:id share these parsers so create and update agree on
// what a title and a due date may be. Before this, PATCH ignored `dueAt: null`
// (so a deadline could never be removed) and silently dropped a malformed date.
// server.mjs and the e2e mock backend both build their rows and responses from
// parseManualTaskCreate, parseManualTaskUpdate and mapManualTaskRow, so the route
// handlers stay thin and the tests here cover what they store and return.

export const MAX_TASK_TITLE = 500

const TITLE_MESSAGE = `Title is required (max ${MAX_TASK_TITLE} characters)`

/**
 * Parse a task title.
 * @param {unknown} value
 * @param {{ required: boolean }} options `required: false` (update) treats an
 *   absent (undefined) title as "leave unchanged"; a title that IS supplied
 *   follows the same rule as create.
 * @returns {{ ok: true, value: string | undefined } | { ok: false, message: string }}
 */
export function parseTaskTitle(value, { required }) {
  if (!required && value === undefined) return { ok: true, value: undefined }
  const title = String(value || '').trim()
  if (!title || title.length > MAX_TASK_TITLE) return { ok: false, message: TITLE_MESSAGE }
  return { ok: true, value: title }
}

/**
 * Parse a task due date. The column is nullable
 * (db/supabase-manual-task-due-optional.sql), so `null` or `''` means no
 * deadline in both modes, which on update clears an existing one. A dueAt that
 * is supplied must be a parseable timestamp string: a malformed value is an
 * error rather than being stored as no deadline or dropped.
 * @param {unknown} value
 * @param {{ mode: 'create' | 'update' }} options on update, an absent
 *   (undefined) dueAt returns `value: undefined` so the column is left alone.
 * @returns {{ ok: true, value: string | null | undefined } | { ok: false, message: string }}
 */
export function parseDueAt(value, { mode }) {
  if (value === undefined) return { ok: true, value: mode === 'update' ? undefined : null }
  if (value === null || value === '') return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: 'dueAt must be an ISO timestamp string' }
  const due = new Date(value)
  if (Number.isNaN(due.getTime())) return { ok: false, message: 'Invalid dueAt date' }
  return { ok: true, value: due.toISOString() }
}

/**
 * The body of POST /api/me/tasks/manual as the columns to insert (the route
 * adds user_id). The title is checked before dueAt.
 * @param {unknown} body
 * @returns {{ ok: true, row: { title: string, due_at: string | null } } | { ok: false, message: string }}
 */
export function parseManualTaskCreate(body) {
  const { title, dueAt } = body || {}
  const t = parseTaskTitle(title, { required: true })
  if (!t.ok) return t
  const due = parseDueAt(dueAt, { mode: 'create' })
  if (!due.ok) return due
  return { ok: true, row: { title: t.value, due_at: due.value } }
}

/**
 * The body of PATCH /api/me/tasks/manual/:id as the columns to update. Only the
 * fields the body supplies are set, so `{ dueAt: null }` yields
 * `{ due_at: null }` and clears the deadline. Any invalid field fails the whole
 * request, so a malformed dueAt never lets the other fields save on their own.
 * @param {unknown} body
 * @param {{ now: string }} options ISO timestamp stored as completed_at for `completed: true`
 * @returns {{ ok: true, updates: Record<string, string | null> } | { ok: false, message: string }}
 */
export function parseManualTaskUpdate(body, { now }) {
  const { completed, title, dueAt } = body || {}
  const updates = {}
  if (typeof completed === 'boolean') updates.completed_at = completed ? now : null
  const t = parseTaskTitle(title, { required: false })
  if (!t.ok) return t
  if (t.value !== undefined) updates.title = t.value
  const due = parseDueAt(dueAt, { mode: 'update' })
  if (!due.ok) return due
  if (due.value !== undefined) updates.due_at = due.value
  if (Object.keys(updates).length === 0) return { ok: false, message: 'No valid fields to update' }
  return { ok: true, updates }
}

/**
 * A user_manual_tasks row as the API returns it. due_at surfaces as startTime,
 * so a task whose deadline was cleared comes back with `startTime: null`.
 * @param {{ id: string, title: string, due_at: string | null, completed_at: string | null }} row
 */
export function mapManualTaskRow(row) {
  return {
    id: row.id,
    title: row.title,
    startTime: row.due_at,
    endTime: null,
    category: 'manual_task',
    sourceType: 'manual',
    description: null,
    location: null,
    externalUid: null,
    sourceId: null,
    completedAt: row.completed_at,
    isManual: true,
  }
}
