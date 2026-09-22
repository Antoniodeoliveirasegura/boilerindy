// studyGroupJoin.mjs
//
// Joining a study group used to be a read-then-insert: read the member rows,
// compare their number with study_groups.capacity, then insert. Two students
// joining a group with one seat left both read count = capacity - 1, both pass
// the check and both insert, so the group ended up over capacity (issue #207).
//
// The preferred path is a Postgres function (db/supabase-study-group-join.sql)
// that locks the group row, counts, checks and inserts in one transaction, the
// same shape as the atomic counters in db/supabase-atomic-counters.sql. When
// that migration has not been applied the code falls back to the old
// read-then-insert, so joins keep working; the fallback is still racy, which is
// what installing the function fixes.
//
// The route owns the group lookup, because whether a group is live depends on
// study_groups.deleted_at, an optional column the SQL function cannot name. This
// module owns only the capacity decision and the insert.

import { isMissingFunctionError } from './communityCounters.mjs'

/** Outcomes the join can reach, from the RPC or the fallback. */
export const JOIN_OUTCOME = Object.freeze({
  joined: 'joined',
  already: 'already',
  full: 'full',
  notFound: 'not_found',
})

function clampCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

/**
 * Map a join outcome to the response the route sends.
 * @param {{ outcome: string, memberCount?: number }} result
 * @returns {{ status: number, body: object }}
 */
export function joinOutcomeToResponse({ outcome, memberCount = 0 } = {}) {
  if (outcome === JOIN_OUTCOME.notFound) {
    return { status: 404, body: { error: { message: 'Group not found.', status: 404 } } }
  }
  if (outcome === JOIN_OUTCOME.full) {
    return { status: 409, body: { error: { message: 'This group is full.', status: 409 } } }
  }
  // joined and already are both a 200: joining twice is not an error, and the
  // client only needs the resulting member count.
  return { status: 200, body: { ok: true, memberCount: clampCount(memberCount) } }
}

// The old path, kept for installations where the function is not there yet.
// Two simultaneous joins can still both pass the check here.
async function joinWithoutFunction(supabase, { groupId, userId, capacity, now }) {
  const { data: members, error } = await supabase
    .from('study_group_members')
    .select('user_id')
    .eq('group_id', groupId)
  if (error) return { error }

  const rows = members || []
  const already = rows.some((m) => m.user_id === userId)
  if (already) return { outcome: JOIN_OUTCOME.already, memberCount: rows.length }
  if (capacity && rows.length >= capacity) {
    return { outcome: JOIN_OUTCOME.full, memberCount: rows.length }
  }

  const { error: insertError } = await supabase
    .from('study_group_members')
    .insert({ group_id: groupId, user_id: userId, joined_at: now })
  // 23505 means someone else inserted the same (group_id, user_id) first, which
  // is this student joining twice, not a capacity problem.
  if (insertError && insertError.code !== '23505') return { error: insertError }
  if (insertError) return { outcome: JOIN_OUTCOME.already, memberCount: rows.length }

  return { outcome: JOIN_OUTCOME.joined, memberCount: rows.length + 1 }
}

/**
 * Add a student to a group, refusing when the group is full.
 * @param {object} supabase service-role client
 * @param {{ groupId: string, userId: string, capacity?: number | null, now: string }} args
 *   capacity and now are only used by the fallback; the function reads capacity itself
 * @returns {Promise<{ outcome?: string, memberCount?: number, error?: unknown }>}
 */
export async function joinStudyGroup(supabase, { groupId, userId, capacity = null, now }) {
  const { data, error } = await supabase.rpc('join_study_group', {
    p_group_id: groupId,
    p_user_id: userId,
  })

  if (!error) {
    const status = data?.status
    const known = Object.values(JOIN_OUTCOME).includes(status)
    // An unrecognised status means the installed function is not the one this
    // module expects; treat it as a failure rather than reporting a join that
    // may not have happened.
    if (!known) return { error: new Error(`join_study_group returned an unknown status: ${String(status)}`) }
    return { outcome: status, memberCount: clampCount(data?.member_count) }
  }

  if (!isMissingFunctionError(error)) return { error }
  return joinWithoutFunction(supabase, { groupId, userId, capacity, now })
}
