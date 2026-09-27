import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BLOCKS, excludeBlocked, isBlockedEither, loadBlockedIds } from '../src/blocks.mjs'
import { fakeSupabase, hasCall } from './routes/fakeSupabase.mjs'

// Issue #192: the block set every list of other students' content reads, and
// the filter that applies it in the query.

const ME = '11111111-1111-4111-8111-111111111111'
const BLOCKED_BY_ME = '22222222-2222-4222-8222-222222222222'
const BLOCKED_ME = '33333333-3333-4333-8333-333333333333'

test('a student can block at most 500 users', () => {
  assert.equal(MAX_BLOCKS, 500)
})

test('loadBlockedIds folds both directions into one set of the other users, in one query', async () => {
  const supabase = fakeSupabase({
    blocked_users: () => ({
      data: [
        { blocker_id: ME, blocked_id: BLOCKED_BY_ME },
        { blocker_id: BLOCKED_ME, blocked_id: ME },
      ],
      error: null,
    }),
  })
  const ids = await loadBlockedIds(supabase, ME)
  assert.deepEqual([...ids], [BLOCKED_BY_ME, BLOCKED_ME])
  assert.equal(supabase.queries.length, 1)
  const [{ chain }] = supabase.queries
  assert.ok(hasCall(chain, 'select', 'blocker_id, blocked_id'))
  assert.ok(hasCall(chain, 'or', `blocker_id.eq.${ME},blocked_id.eq.${ME}`))
})

test('loadBlockedIds is empty before README step 38 runs, and throws any other failure', async () => {
  const missing = fakeSupabase({
    blocked_users: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.blocked_users' in the schema cache" } }),
  })
  assert.equal((await loadBlockedIds(missing, ME)).size, 0)
  // Showing a blocked user's content is worse than failing the read.
  const timeout = { code: '57014', message: 'canceling statement due to statement timeout' }
  const failing = fakeSupabase({ blocked_users: () => ({ data: null, error: timeout }) })
  await assert.rejects(loadBlockedIds(failing, ME), (e) => e === timeout)
})

test('excludeBlocked adds one not-in filter for a non-empty set and leaves the query alone otherwise', () => {
  const calls = []
  const query = {
    not(...args) {
      calls.push(args)
      return 'filtered'
    },
  }
  assert.equal(excludeBlocked(query, 'user_id', new Set()), query)
  assert.equal(excludeBlocked(query, 'user_id', undefined), query)
  assert.deepEqual(calls, [])
  assert.equal(excludeBlocked(query, 'creator_id', new Set([BLOCKED_BY_ME, BLOCKED_ME])), 'filtered')
  assert.deepEqual(calls, [['creator_id', 'in', `(${BLOCKED_BY_ME},${BLOCKED_ME})`]])
})

test('isBlockedEither reads the folded set and is false without an id', () => {
  const blocked = new Set([BLOCKED_BY_ME, BLOCKED_ME])
  assert.equal(isBlockedEither(blocked, BLOCKED_BY_ME), true)
  assert.equal(isBlockedEither(blocked, BLOCKED_ME), true)
  assert.equal(isBlockedEither(blocked, ME), false)
  assert.equal(isBlockedEither(blocked, null), false)
  assert.equal(isBlockedEither(blocked, undefined), false)
})
