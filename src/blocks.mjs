// Blocking users (issue #192). A block by either side hides the two users
// from each other everywhere and stops connection requests between them, so
// every read that lists other students' content asks for the caller's whole
// block set, both directions, once per request, and filters it in the query
// (not after it) so paging stays exact.

import { isSchemaMissingError } from './dbErrors.mjs'

/** The most users one student can block. */
export const MAX_BLOCKS = 500

/**
 * The users on the other side of every block the caller is part of: the ones
 * they blocked and the ones who blocked them. Empty while blocked_users does
 * not exist yet (README step 38), so every list keeps working before it runs;
 * any other failure is thrown, because showing a blocked user's content is
 * worse than failing the read.
 * @param {object} supabase
 * @param {string} userId
 * @returns {Promise<Set<string>>}
 */
export async function loadBlockedIds(supabase, userId) {
  const { data, error } = await supabase
    .from('blocked_users')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`)
  if (error) {
    if (isSchemaMissingError(error)) return new Set()
    throw error
  }
  const ids = new Set()
  for (const row of data || []) ids.add(row.blocker_id === userId ? row.blocked_id : row.blocker_id)
  ids.delete(userId)
  return ids
}

/**
 * Leave out rows whose `column` names a blocked user. The ids are UUIDs from
 * the database, so the PostgREST list needs no quoting. Returns the query
 * unchanged when nothing is blocked, so the common case adds no filter. (Not
 * named for authors: CodeQL's js/missing-rate-limiting reads any call named
 * like "auth" as an authorization check.)
 * @template Q
 * @param {Q & { not: (column: string, op: string, value: string) => Q }} query
 * @param {string} column
 * @param {Set<string>} blockedIds
 * @returns {Q}
 */
export function excludeBlocked(query, column, blockedIds) {
  if (!blockedIds || blockedIds.size === 0) return query
  return query.not(column, 'in', `(${[...blockedIds].join(',')})`)
}

/**
 * True when a block stands between the caller and `otherId`, in either
 * direction (loadBlockedIds already folded both in).
 * @param {Set<string>} blockedIds
 * @param {string | null | undefined} otherId
 */
export function isBlockedEither(blockedIds, otherId) {
  return Boolean(otherId) && blockedIds.has(otherId)
}
