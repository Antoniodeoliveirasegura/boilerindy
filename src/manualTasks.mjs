// Manual tasks (issue #216). POST /api/me/tasks/manual and PATCH
// /api/me/tasks/manual/:id share these parsers so create and update agree on
// what a title and a due date may be. Before this, PATCH ignored `dueAt: null`
// (so a deadline could never be removed) and silently dropped a malformed date.

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
