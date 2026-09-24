import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toggleUpvote } from '../src/upvoteToggle.mjs'

// Issue #191 - the one upvote toggle behind POST /api/board/posts/:id/upvote and
// POST /api/guide/:id/upvote. A minimal Supabase double records the calls.

function fakeSupabase({ insertError = null, deleteError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      return {
        insert: async (row) => {
          calls.push({ op: 'insert', table, row })
          return { error: insertError }
        },
        delete: () => ({
          eq: (col1, val1) => ({
            eq: async (col2, val2) => {
              calls.push({ op: 'delete', table, where: { [col1]: val1, [col2]: val2 } })
              return { error: deleteError }
            },
          }),
        }),
      }
    },
  }
}

const args = (supabase, syncCount) => ({
  supabase,
  table: 'board_upvotes',
  refColumn: 'post_id',
  refId: 'post-1',
  userId: 'user-1',
  now: '2026-09-24T12:00:00.000Z',
  syncCount,
})

test('a first vote inserts the row and answers the re-derived total', async () => {
  const supabase = fakeSupabase()
  const synced = []
  const result = await toggleUpvote(args(supabase, async (id) => (synced.push(id), { count: 3 })))
  assert.deepEqual(result, { upvotes: 3, upvotedByMe: true })
  assert.deepEqual(supabase.calls, [
    { op: 'insert', table: 'board_upvotes', row: { post_id: 'post-1', user_id: 'user-1', created_at: '2026-09-24T12:00:00.000Z' } },
  ])
  assert.deepEqual(synced, ['post-1'])
})

test('a duplicate vote (23505) removes the row instead', async () => {
  const supabase = fakeSupabase({ insertError: { code: '23505', message: 'duplicate key' } })
  const result = await toggleUpvote(args(supabase, async () => ({ count: 2 })))
  assert.deepEqual(result, { upvotes: 2, upvotedByMe: false })
  assert.deepEqual(supabase.calls[1], { op: 'delete', table: 'board_upvotes', where: { post_id: 'post-1', user_id: 'user-1' } })
})

test('any other insert error, a failed removal or a failed recount is thrown for the responder', async () => {
  const insertFailure = { code: '42P01', message: 'relation does not exist' }
  await assert.rejects(toggleUpvote(args(fakeSupabase({ insertError: insertFailure }), async () => ({ count: 0 }))), (e) => e === insertFailure)

  const deleteFailure = { code: 'XX000', message: 'boom' }
  await assert.rejects(
    toggleUpvote(args(fakeSupabase({ insertError: { code: '23505' }, deleteError: deleteFailure }), async () => ({ count: 0 }))),
    (e) => e === deleteFailure,
  )

  const countFailure = { code: 'PGRST202', message: 'function missing' }
  await assert.rejects(toggleUpvote(args(fakeSupabase(), async () => ({ count: null, error: countFailure }))), (e) => e === countFailure)
})
