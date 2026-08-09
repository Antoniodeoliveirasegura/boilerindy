// communityCounters.mjs
//
// board_posts.reply_count, board_posts.upvote_count and
// guide_recommendations.upvote_count are denormalized counters kept for the hot
// read path (the board / guide list endpoints sort and display by them). They
// used to be maintained with a read-modify-write: read N from a row fetched
// earlier in the handler, then write N + 1. That loses updates under
// concurrency - two simultaneous votes/replies both read N and both write
// N + 1, so the stored count drifts below the real number of vote/reply rows.
//
// This store recomputes each counter FROM its source rows instead. The
// preferred path is a Postgres function (db/supabase-atomic-counters.sql) that
// locks the parent row, counts the source rows and writes the total in one
// transaction - correct under concurrency and self-healing (it repairs drift
// the old code already caused). When that migration has not been applied yet the
// code falls back to a best-effort count-then-write, mirroring the edited_at
// fallback in server.mjs: it reads the live row count rather than a stale cached
// value, so it can no longer lose updates the way read-N-write-N+1 did.
//
// The vote-row toggle (insert / delete of the per-user board_upvotes /
// guide_upvotes row) stays in the request handlers; this module only owns the
// counter maintenance, and every method returns { count, error } to match the
// { data, error } shape the handlers already branch on for supabase calls.

function clampCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

// PostgREST reports an unknown function as PGRST202; Postgres itself uses 42883
// (undefined_function). Either means db/supabase-atomic-counters.sql has not run
// yet, so we fall back instead of failing the vote/reply.
export function isMissingFunctionError(error) {
  if (!error) return false
  if (error.code === 'PGRST202' || error.code === '42883') return true
  const msg = String(error.message || '').toLowerCase()
  return msg.includes('could not find the function') || msg.includes('does not exist')
}

export function createCommunityCounters(supabase) {
  // Recompute one denormalized counter from its source rows and return the
  // stored total. Prefers the atomic RPC; falls back to count-then-write only
  // when the RPC is missing. Any other error is surfaced to the caller.
  async function recompute({ rpc, rpcArg, sourceTable, sourceKey, keyValue, targetTable, counterColumn }) {
    const { data, error } = await supabase.rpc(rpc, rpcArg)
    if (!error) return { count: clampCount(data) }
    if (!isMissingFunctionError(error)) return { error }

    const { count, error: countError } = await supabase
      .from(sourceTable)
      .select('*', { count: 'exact', head: true })
      .eq(sourceKey, keyValue)
    if (countError) return { error: countError }

    const total = clampCount(count)
    const { error: updateError } = await supabase
      .from(targetTable)
      .update({ [counterColumn]: total })
      .eq('id', keyValue)
    if (updateError) return { error: updateError }
    return { count: total }
  }

  return {
    syncBoardPostUpvotes(postId) {
      return recompute({
        rpc: 'sync_board_post_upvote_count',
        rpcArg: { p_post_id: postId },
        sourceTable: 'board_upvotes',
        sourceKey: 'post_id',
        keyValue: postId,
        targetTable: 'board_posts',
        counterColumn: 'upvote_count',
      })
    },
    syncBoardPostReplies(postId) {
      return recompute({
        rpc: 'sync_board_post_reply_count',
        rpcArg: { p_post_id: postId },
        sourceTable: 'board_replies',
        sourceKey: 'post_id',
        keyValue: postId,
        targetTable: 'board_posts',
        counterColumn: 'reply_count',
      })
    },
    syncGuideRecUpvotes(recId) {
      return recompute({
        rpc: 'sync_guide_rec_upvote_count',
        rpcArg: { p_rec_id: recId },
        sourceTable: 'guide_upvotes',
        sourceKey: 'rec_id',
        keyValue: recId,
        targetTable: 'guide_recommendations',
        counterColumn: 'upvote_count',
      })
    },
  }
}
