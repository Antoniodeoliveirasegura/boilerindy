import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommunityCounters, isMissingFunctionError } from '../src/communityCounters.mjs'

// board_posts.reply_count / upvote_count and guide_recommendations.upvote_count
// used to be maintained with read-modify-write: read N from a row fetched
// earlier in the handler, then write N + 1. Two concurrent votes/replies both
// read N and both write N + 1, so the stored count lost an update and drifted
// below the real number of rows. These tests pin the new behaviour: the counter
// is DERIVED from the source rows (atomic RPC, or a count-then-write fallback),
// never from arithmetic on a possibly-stale cached value.

// Maps each RPC to the source it counts and the counter it writes, so the fake
// can model the real Postgres function: recount the rows, store the total.
const RPC_MAP = {
  sync_board_post_upvote_count: { argKey: 'p_post_id', source: 'board_upvotes', sourceKey: 'post_id', target: 'board_posts', col: 'upvote_count' },
  sync_board_post_reply_count: { argKey: 'p_post_id', source: 'board_replies', sourceKey: 'post_id', target: 'board_posts', col: 'reply_count' },
  sync_guide_rec_upvote_count: { argKey: 'p_rec_id', source: 'guide_upvotes', sourceKey: 'rec_id', target: 'guide_recommendations', col: 'upvote_count' },
}

// Faithful model of the atomic DB function: count the source rows for the id and
// write that total onto the parent row.
function atomicRpc(name, arg, store) {
  const m = RPC_MAP[name]
  const id = arg[m.argKey]
  const count = (store[m.source] || []).filter((r) => r[m.sourceKey] === id).length
  if (store[m.target]?.[id]) store[m.target][id][m.col] = count
  return { data: count, error: null }
}

function makeSupabase({ rpc = atomicRpc, tables = {}, countError = null, updateError = null } = {}) {
  const calls = []
  const store = {
    board_upvotes: [],
    board_replies: [],
    guide_upvotes: [],
    board_posts: {},
    guide_recommendations: {},
    ...tables,
  }
  const supabase = {
    rpc(name, arg) {
      calls.push({ op: 'rpc', name, arg })
      return Promise.resolve(rpc(name, arg, store))
    },
    from(table) {
      return {
        // Fallback count query: .select('*', { count: 'exact', head: true }).eq(k, v)
        select(sel, opts) {
          return {
            eq(col, val) {
              calls.push({ op: 'select', table, sel, opts, col, val })
              if (countError) return Promise.resolve({ count: null, data: null, error: countError })
              const rows = (store[table] || []).filter((r) => r[col] === val)
              return Promise.resolve({ count: rows.length, data: null, error: null })
            },
          }
        },
        // Fallback write: .update(patch).eq('id', val)
        update(patch) {
          return {
            eq(col, val) {
              calls.push({ op: 'update', table, patch, col, val })
              if (updateError) return Promise.resolve({ error: updateError })
              if (store[table]?.[val]) Object.assign(store[table][val], patch)
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
  }
  return { supabase, calls, store }
}

test('derives the total from the source rows via the atomic RPC, not the cached counter', async () => {
  const { supabase, calls, store } = makeSupabase({
    tables: {
      board_upvotes: [{ post_id: 'p1', user_id: 'a' }, { post_id: 'p1', user_id: 'b' }],
      board_posts: { p1: { id: 'p1', upvote_count: 999 } }, // stale/drifted value
    },
  })
  const counters = createCommunityCounters(supabase)

  const { count, error } = await counters.syncBoardPostUpvotes('p1')

  assert.equal(error, undefined)
  assert.equal(count, 2) // the two real rows win over the cached 999
  assert.equal(store.board_posts.p1.upvote_count, 2)
  assert.equal(calls.filter((c) => c.op === 'select').length, 0) // RPC path: no fallback
  assert.equal(calls.find((c) => c.op === 'rpc').arg.p_post_id, 'p1')
})

test('each method calls its own function with the right argument shape', async () => {
  const { supabase, calls } = makeSupabase({ rpc: () => ({ data: 0, error: null }) })
  const counters = createCommunityCounters(supabase)

  await counters.syncBoardPostUpvotes('p1')
  await counters.syncBoardPostReplies('p2')
  await counters.syncGuideRecUpvotes('r3')

  const rpcs = calls.filter((c) => c.op === 'rpc')
  assert.deepEqual(rpcs.map((c) => c.name), [
    'sync_board_post_upvote_count',
    'sync_board_post_reply_count',
    'sync_guide_rec_upvote_count',
  ])
  assert.deepEqual(rpcs.map((c) => c.arg), [{ p_post_id: 'p1' }, { p_post_id: 'p2' }, { p_rec_id: 'r3' }])
})

test('concurrent votes converge to the true row count (no lost update)', async () => {
  const { supabase, store } = makeSupabase({
    tables: { board_upvotes: [], board_posts: { p1: { id: 'p1', upvote_count: 0 } } },
  })
  const counters = createCommunityCounters(supabase)

  // Two users upvote: the handler inserts each vote row, then triggers a sync.
  // Old read-modify-write: both read 0 and write 1 -> stored 1 (a lost update).
  // Recompute-from-rows: both syncs see 2 rows -> stored 2.
  store.board_upvotes.push({ post_id: 'p1', user_id: 'a' })
  store.board_upvotes.push({ post_id: 'p1', user_id: 'b' })
  const [r1, r2] = await Promise.all([
    counters.syncBoardPostUpvotes('p1'),
    counters.syncBoardPostUpvotes('p1'),
  ])

  assert.equal(store.board_posts.p1.upvote_count, 2)
  assert.equal(r1.count, 2)
  assert.equal(r2.count, 2)
})

test('falls back to counting rows when the migration is missing, ignoring the cached counter', async () => {
  const { supabase, calls, store } = makeSupabase({
    rpc: () => ({ error: { code: 'PGRST202', message: 'Could not find the function public.sync_board_post_upvote_count' } }),
    tables: {
      board_upvotes: [{ post_id: 'p1', user_id: 'a' }, { post_id: 'p1', user_id: 'b' }, { post_id: 'p1', user_id: 'c' }],
      board_posts: { p1: { id: 'p1', upvote_count: 999 } },
    },
  })
  const counters = createCommunityCounters(supabase)

  const { count, error } = await counters.syncBoardPostUpvotes('p1')

  assert.equal(error, undefined)
  assert.equal(count, 3)
  assert.equal(store.board_posts.p1.upvote_count, 3) // wrote the counted value, not 999 +/- 1

  const sel = calls.find((c) => c.op === 'select')
  assert.equal(sel.table, 'board_upvotes')
  assert.equal(sel.col, 'post_id')
  assert.equal(sel.val, 'p1')
  assert.equal(sel.opts.count, 'exact')
  assert.equal(sel.opts.head, true)

  const upd = calls.find((c) => c.op === 'update')
  assert.equal(upd.table, 'board_posts')
  assert.equal(upd.col, 'id')
  assert.equal(upd.val, 'p1')
  assert.deepEqual(upd.patch, { upvote_count: 3 })
})

test('guide fallback counts guide_upvotes by rec_id and writes upvote_count', async () => {
  const { supabase, calls, store } = makeSupabase({
    rpc: () => ({ error: { code: '42883', message: 'function ... does not exist' } }),
    tables: {
      guide_upvotes: [{ rec_id: 'r9', user_id: 'a' }],
      guide_recommendations: { r9: { id: 'r9', upvote_count: 42 } },
    },
  })
  const counters = createCommunityCounters(supabase)

  const { count } = await counters.syncGuideRecUpvotes('r9')

  assert.equal(count, 1)
  assert.equal(store.guide_recommendations.r9.upvote_count, 1)
  const sel = calls.find((c) => c.op === 'select')
  assert.equal(sel.table, 'guide_upvotes')
  assert.equal(sel.col, 'rec_id')
})

test('surfaces a real RPC error instead of silently falling back', async () => {
  const { supabase, calls } = makeSupabase({
    rpc: () => ({ error: { code: '42501', message: 'permission denied' } }),
  })
  const counters = createCommunityCounters(supabase)

  const { count, error } = await counters.syncBoardPostUpvotes('p1')

  assert.equal(count, undefined)
  assert.equal(error.code, '42501')
  assert.equal(calls.some((c) => c.op === 'select'), false) // did not fall back
})

test('surfaces a fallback count error', async () => {
  const { supabase } = makeSupabase({
    rpc: () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }),
    countError: { message: 'boom' },
  })
  const counters = createCommunityCounters(supabase)

  const { error } = await counters.syncBoardPostReplies('p1')

  assert.equal(error.message, 'boom')
})

test('isMissingFunctionError recognizes only the not-yet-migrated cases', () => {
  assert.equal(isMissingFunctionError({ code: 'PGRST202' }), true)
  assert.equal(isMissingFunctionError({ code: '42883' }), true)
  assert.equal(isMissingFunctionError({ message: 'Could not find the function public.sync_x' }), true)
  assert.equal(isMissingFunctionError({ code: '23505', message: 'duplicate key value' }), false)
  assert.equal(isMissingFunctionError(null), false)
})
