/**
 * Toggle a user's upvote on a row (issue #191). The board and the guide carried
 * byte-identical copies of this: insert the vote row; a duplicate (23505) means
 * the vote was already there, so remove it instead; then re-derive the total
 * from the vote rows. Any other database error is thrown for the caller's
 * responder. The row itself (a post, a recommendation) is checked by the caller,
 * whose table and "not found" wording differ.
 *
 * @param {object} args
 * @param {object} args.supabase   the Supabase client
 * @param {string} args.table      the vote table, e.g. 'board_upvotes'
 * @param {string} args.refColumn  the column naming the voted row, e.g. 'post_id'
 * @param {string} args.refId      the voted row's id
 * @param {string} args.userId     the voter
 * @param {string} args.now        ISO timestamp for a new vote row
 * @param {(refId: string) => Promise<{ count: number, error?: unknown }>} args.syncCount
 *   re-derives and stores the row's total, answering the new count
 * @returns {Promise<{ upvotedByMe: boolean, upvotes: number }>}
 */
export async function toggleUpvote({ supabase, table, refColumn, refId, userId, now, syncCount }) {
  const { error: insertError } = await supabase
    .from(table)
    .insert({ [refColumn]: refId, user_id: userId, created_at: now })

  let upvotedByMe
  if (insertError && insertError.code === '23505') {
    const { error: deleteError } = await supabase.from(table).delete().eq(refColumn, refId).eq('user_id', userId)
    if (deleteError) throw deleteError
    upvotedByMe = false
  } else if (insertError) {
    throw insertError
  } else {
    upvotedByMe = true
  }

  // Derive the new total from the vote rows atomically (was read-modify-write).
  const { count, error: countError } = await syncCount(refId)
  if (countError) throw countError
  return { upvotes: count, upvotedByMe }
}
