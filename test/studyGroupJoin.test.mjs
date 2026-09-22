import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JOIN_OUTCOME, joinOutcomeToResponse, joinStudyGroup } from '../src/studyGroupJoin.mjs'

// Joining used to be a read-then-insert: count the member rows, compare with
// capacity, insert. Two students taking the last seat both read
// count = capacity - 1 and both got in (issue #207). These tests pin the new
// behaviour: the decision and the insert happen together, in the database, and
// the old path survives only as a fallback for installations where
// db/supabase-study-group-join.sql has not been run yet.

const GROUP = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'
const ADA = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-09-22T12:00:00.000Z'

// Faithful model of join_study_group: the row lock means count, check and
// insert see a consistent view, so it is modelled as one synchronous step.
function atomicRpc(store, { p_group_id: groupId, p_user_id: userId }) {
  if (!store.groups[groupId]) return { data: { status: 'not_found' }, error: null }
  const rows = store.members.filter((m) => m.group_id === groupId)
  if (rows.some((m) => m.user_id === userId)) {
    return { data: { status: 'already', member_count: rows.length }, error: null }
  }
  const { capacity } = store.groups[groupId]
  if (capacity != null && rows.length >= capacity) {
    return { data: { status: 'full', member_count: rows.length }, error: null }
  }
  store.members.push({ group_id: groupId, user_id: userId, joined_at: NOW })
  return { data: { status: 'joined', member_count: rows.length + 1 }, error: null }
}

const missingFunction = {
  code: 'PGRST202',
  message: 'Could not find the function public.join_study_group(p_group_id, p_user_id) in the schema cache',
}

function makeSupabase({ capacity = null, members = [], rpc = null, rpcError = null } = {}) {
  const store = {
    groups: { [GROUP]: { capacity } },
    members: members.map((user_id) => ({ group_id: GROUP, user_id, joined_at: NOW })),
  }
  const calls = []
  const supabase = {
    store,
    calls,
    rpc(name, arg) {
      calls.push({ op: 'rpc', name, arg })
      if (rpcError) return Promise.resolve({ data: null, error: rpcError })
      if (rpc) return Promise.resolve(rpc(store, arg))
      return Promise.resolve(atomicRpc(store, arg))
    },
    from(table) {
      return {
        select(cols) {
          return {
            // Async on purpose: two joins running at once both read here before
            // either insert lands, which is exactly the race being modelled.
            async eq(_column, value) {
              calls.push({ op: 'select', table, cols })
              await null
              return { data: store.members.filter((m) => m.group_id === value), error: null }
            },
          }
        },
        async insert(row) {
          calls.push({ op: 'insert', table, row })
          await null
          const clash = store.members.some((m) => m.group_id === row.group_id && m.user_id === row.user_id)
          if (clash) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          }
          store.members.push(row)
          return { error: null }
        },
      }
    },
  }
  return supabase
}

const join = (supabase, userId, capacity = null) =>
  joinStudyGroup(supabase, { groupId: GROUP, userId, capacity, now: NOW })

test('joinOutcomeToResponse maps every outcome to its response', () => {
  assert.deepEqual(joinOutcomeToResponse({ outcome: JOIN_OUTCOME.joined, memberCount: 3 }), {
    status: 200,
    body: { ok: true, memberCount: 3 },
  })
  assert.deepEqual(joinOutcomeToResponse({ outcome: JOIN_OUTCOME.already, memberCount: 3 }), {
    status: 200,
    body: { ok: true, memberCount: 3 },
  })
  assert.deepEqual(joinOutcomeToResponse({ outcome: JOIN_OUTCOME.full, memberCount: 4 }), {
    status: 409,
    body: { error: { message: 'This group is full.', status: 409 } },
  })
  assert.deepEqual(joinOutcomeToResponse({ outcome: JOIN_OUTCOME.notFound }), {
    status: 404,
    body: { error: { message: 'Group not found.', status: 404 } },
  })
})

test('joinOutcomeToResponse never reports a negative or non-numeric count', () => {
  assert.deepEqual(joinOutcomeToResponse({ outcome: JOIN_OUTCOME.joined, memberCount: -2 }).body, { ok: true, memberCount: 0 })
  assert.deepEqual(joinOutcomeToResponse({ outcome: JOIN_OUTCOME.joined, memberCount: undefined }).body, { ok: true, memberCount: 0 })
})

test('the function path joins, repeats and refuses a full group', async () => {
  const supabase = makeSupabase({ capacity: 2 })
  assert.deepEqual(await join(supabase, ADA), { outcome: 'joined', memberCount: 1 })
  assert.deepEqual(await join(supabase, ADA), { outcome: 'already', memberCount: 1 })
  assert.deepEqual(await join(supabase, BOB), { outcome: 'joined', memberCount: 2 })
  assert.deepEqual(await join(supabase, '33333333-3333-4333-8333-333333333333'), { outcome: 'full', memberCount: 2 })
  assert.equal(supabase.store.members.length, 2)
  assert.ok(supabase.calls.every((c) => c.op === 'rpc'), 'the function path should not query tables directly')
})

test('a group that is not there is 404, not a crash', async () => {
  const supabase = makeSupabase()
  const result = await joinStudyGroup(supabase, { groupId: 'missing', userId: ADA, now: NOW })
  assert.equal(result.outcome, JOIN_OUTCOME.notFound)
  assert.equal(joinOutcomeToResponse(result).status, 404)
})

test('a capacity of null means the group has no limit', async () => {
  const supabase = makeSupabase({ capacity: null, members: [ADA, BOB] })
  const result = await join(supabase, '44444444-4444-4444-8444-444444444444')
  assert.equal(result.outcome, JOIN_OUTCOME.joined)
  assert.equal(result.memberCount, 3)
})

test('two simultaneous joins for one seat: one gets in, the other is told it is full', async () => {
  const supabase = makeSupabase({ capacity: 1 })
  const [first, second] = await Promise.all([join(supabase, ADA), join(supabase, BOB)])
  const outcomes = [first.outcome, second.outcome].sort()
  assert.deepEqual(outcomes, ['full', 'joined'])
  assert.equal(supabase.store.members.length, 1, 'the group went over capacity')
})

test('the same race on the fallback is what the migration exists to fix', async () => {
  // Not a wish: this pins why db/supabase-study-group-join.sql matters. The
  // fallback reads, then inserts, so both students pass the check.
  const supabase = makeSupabase({ capacity: 1, rpcError: missingFunction })
  const results = await Promise.all([join(supabase, ADA, 1), join(supabase, BOB, 1)])
  assert.deepEqual(results.map((r) => r.outcome), ['joined', 'joined'])
  assert.equal(supabase.store.members.length, 2, 'the fallback is expected to be racy')
})

test('a missing function falls back to the read-then-insert path', async () => {
  const supabase = makeSupabase({ capacity: 3, rpcError: missingFunction })
  const result = await join(supabase, ADA, 3)
  assert.deepEqual(result, { outcome: JOIN_OUTCOME.joined, memberCount: 1 })
  assert.deepEqual(
    supabase.calls.map((c) => c.op),
    ['rpc', 'select', 'insert'],
    'the fallback should run only after the rpc is found to be missing',
  )
})

test('the fallback refuses a full group and repeats a join without inserting', async () => {
  const full = makeSupabase({ capacity: 2, members: [ADA, BOB], rpcError: missingFunction })
  const refused = await join(full, '55555555-5555-4555-8555-555555555555', 2)
  assert.deepEqual(refused, { outcome: JOIN_OUTCOME.full, memberCount: 2 })
  assert.equal(full.calls.filter((c) => c.op === 'insert').length, 0)

  const again = makeSupabase({ capacity: 4, members: [ADA], rpcError: missingFunction })
  assert.deepEqual(await join(again, ADA, 4), { outcome: JOIN_OUTCOME.already, memberCount: 1 })
  assert.equal(again.store.members.length, 1)
})

test('the fallback treats a 23505 on insert as already joined', async () => {
  // The select missed the row (another request inserted between the two calls),
  // so the primary key is what refuses it. That is this student joining twice.
  const supabase = makeSupabase({ capacity: 4, rpcError: missingFunction })
  supabase.store.members.push({ group_id: GROUP, user_id: ADA, joined_at: NOW })
  const result = await joinStudyGroup(supabase, { groupId: GROUP, userId: ADA, capacity: 4, now: NOW, })
  assert.equal(result.outcome, JOIN_OUTCOME.already)
  assert.equal(supabase.store.members.length, 1)
})

test('an rpc failure that is not a missing function is surfaced, never retried as a join', async () => {
  const supabase = makeSupabase({ capacity: 2, rpcError: { code: '08006', message: 'connection failure' } })
  const result = await join(supabase, ADA, 2)
  assert.equal(result.outcome, undefined)
  assert.equal(result.error.code, '08006')
  assert.equal(supabase.store.members.length, 0)
  assert.ok(!supabase.calls.some((c) => c.op === 'insert'), 'a failed rpc must not fall through to an insert')
})

test('an unrecognised status from the function is an error, not a silent success', async () => {
  const supabase = makeSupabase({ rpc: () => ({ data: { status: 'maybe' }, error: null }) })
  const result = await join(supabase, ADA)
  assert.equal(result.outcome, undefined)
  assert.match(String(result.error.message), /unknown status: maybe/)
})
