// Content moderation helpers (issue #195). The soft-delete routes used to be
// owner-scoped only, so a harassing post stayed up until its author removed
// it. These pure helpers let an admin past the owner filter and keep the
// study-group rollout safe before its deleted_at migration runs. They take the
// query builder as an argument, so they are unit-testable without Supabase.

// Every moderated table (board_posts, marketplace_listings, lost_found_items,
// guide_recommendations, deals, study_groups) uses a UUID primary key.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Scope a soft-delete query to the row's owner unless the caller is an admin.
 * Admins match anyone's row; everyone else still only matches their own, so a
 * miss keeps the 404 shape instead of revealing that the row exists.
 * @template {{ eq: (column: string, value: unknown) => any }} Q
 * @param {Q} query
 * @param {{ userId: string, isAdmin: boolean, ownerColumn?: string }} scope
 * @returns {Q}
 */
export function ownerOrAdminScope(query, { userId, isAdmin, ownerColumn = 'user_id' }) {
  // Strict so a truthy non-boolean (a stray string, say) never widens access.
  if (isAdmin === true) return query
  return query.eq(ownerColumn, userId)
}

/**
 * True for a canonical UUID string. Postgres rejects anything else on a UUID
 * column with a 22P02 error, which would otherwise surface as a 500.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * True when the database reports a column that does not exist yet, i.e. the
 * migration adding it has not run. Postgres answers 42703 for a filter or
 * select on an unknown column; PostgREST answers PGRST204 for a write whose
 * body names a column missing from its schema cache.
 * @param {unknown} err
 * @param {string} [column] only match errors that name this column
 * @returns {boolean}
 */
export function isMissingColumnError(err, column) {
  const code = String(err?.code || '')
  if (code !== '42703' && code !== 'PGRST204') return false
  if (!column) return true
  return String(err?.message || '').includes(column)
}

/**
 * Run a read that hides soft-deleted rows, falling back to the unfiltered read
 * while the table has no deleted_at column yet (study groups before
 * db/supabase-study-groups-soft-delete.sql). `buildQuery(true)` must add
 * `.is('deleted_at', null)`; `buildQuery(false)` must not. Nothing can have
 * been soft-deleted before the column exists, so the fallback hides nothing.
 * @template R
 * @param {(liveOnly: boolean) => PromiseLike<R>} buildQuery
 * @returns {Promise<R>}
 */
export async function selectLiveRows(buildQuery) {
  const result = await buildQuery(true)
  if (result?.error && isMissingColumnError(result.error, 'deleted_at')) return buildQuery(false)
  return result
}
