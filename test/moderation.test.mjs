import test from 'node:test'
import assert from 'node:assert/strict'
import { isMissingColumnError, isUuid, ownerOrAdminScope, selectLiveRows } from '../src/moderation.mjs'

// Issue #195: admins could not take down another user's live content, because
// every soft-delete route filtered on user_id. ownerOrAdminScope is the one
// place that decides whether that filter applies.

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ADMIN = '33333333-3333-4333-8333-333333333333'
const POST = '44444444-4444-4444-8444-444444444444'

// Records every filter call so a test can assert on the exact query shape.
function fakeBuilder() {
  const calls = []
  const builder = {
    calls,
    eq(column, value) {
      calls.push(['eq', column, value])
      return builder
    },
  }
  return builder
}

// Minimal in-memory table in the shape of supabase-js: update() then filters,
// resolved by select(). Enough to run the same chains the routes run.
function fakeTable(rows) {
  const matchers = {
    eq: (column, value) => (row) => row[column] === value,
    is: (column, value) => (row) => (row[column] ?? null) === value,
    not: (column, op, value) => (row) => op === 'is' && (row[column] ?? null) !== value,
  }
  return {
    rows,
    update(patch) {
      const filters = []
      const query = {}
      for (const [name, make] of Object.entries(matchers)) {
        query[name] = (...args) => {
          filters.push(make(...args))
          return query
        }
      }
      query.select = async () => {
        const hit = rows.filter((row) => filters.every((keep) => keep(row)))
        for (const row of hit) Object.assign(row, patch)
        return { data: hit.map((row) => ({ id: row.id })), error: null }
      }
      return query
    },
  }
}

// The soft-delete chain the board, guide, lost-found, marketplace and
// study-group DELETE routes share.
function softDelete(table, id, scope) {
  const query = table.update({ deleted_at: '2026-09-16T12:00:00.000Z' }).eq('id', id).is('deleted_at', null)
  return ownerOrAdminScope(query, scope).select('id')
}

// The chain POST /api/admin/deleted/:type/:id/restore runs.
function restore(table, id) {
  return table.update({ deleted_at: null }).eq('id', id).not('deleted_at', 'is', null).select('id')
}

test('an admin skips the owner filter', () => {
  const builder = fakeBuilder()
  const scoped = ownerOrAdminScope(builder, { userId: ADMIN, isAdmin: true })
  assert.equal(scoped, builder)
  assert.deepEqual(builder.calls, [])
})

test('a non-admin is scoped to their own rows on user_id', () => {
  const builder = fakeBuilder()
  ownerOrAdminScope(builder, { userId: OWNER, isAdmin: false })
  assert.deepEqual(builder.calls, [['eq', 'user_id', OWNER]])
})

test('the owner column can be renamed (study_groups uses creator_id)', () => {
  const builder = fakeBuilder()
  ownerOrAdminScope(builder, { userId: OWNER, isAdmin: false, ownerColumn: 'creator_id' })
  assert.deepEqual(builder.calls, [['eq', 'creator_id', OWNER]])
})

test('only a literal true counts as admin', () => {
  for (const isAdmin of ['true', 1, {}, undefined, null]) {
    const builder = fakeBuilder()
    ownerOrAdminScope(builder, { userId: OWNER, isAdmin })
    assert.deepEqual(builder.calls, [['eq', 'user_id', OWNER]], `isAdmin=${String(isAdmin)}`)
  }
})

test("an admin can soft-delete another user's post, and restore brings it back", async () => {
  const table = fakeTable([{ id: POST, user_id: OWNER, deleted_at: null }])

  const removed = await softDelete(table, POST, { userId: ADMIN, isAdmin: true })
  assert.deepEqual(removed.data, [{ id: POST }])
  assert.equal(table.rows[0].deleted_at, '2026-09-16T12:00:00.000Z')

  const restored = await restore(table, POST)
  assert.deepEqual(restored.data, [{ id: POST }])
  assert.equal(table.rows[0].deleted_at, null)
})

test("a non-admin matches no rows on someone else's post, so the route still 404s", async () => {
  const table = fakeTable([{ id: POST, user_id: OWNER, deleted_at: null }])
  const result = await softDelete(table, POST, { userId: OTHER, isAdmin: false })
  assert.deepEqual(result.data, [])
  assert.equal(table.rows[0].deleted_at, null)
})

test('the owner can still soft-delete their own post', async () => {
  const table = fakeTable([{ id: POST, user_id: OWNER, deleted_at: null }])
  const result = await softDelete(table, POST, { userId: OWNER, isAdmin: false })
  assert.deepEqual(result.data, [{ id: POST }])
})

test('an already soft-deleted post is a miss even for an admin', async () => {
  const table = fakeTable([{ id: POST, user_id: OWNER, deleted_at: '2026-09-01T00:00:00.000Z' }])
  const result = await softDelete(table, POST, { userId: ADMIN, isAdmin: true })
  assert.deepEqual(result.data, [])
  assert.equal(table.rows[0].deleted_at, '2026-09-01T00:00:00.000Z')
})

test('isUuid accepts canonical UUIDs in either case and rejects everything else', () => {
  assert.equal(isUuid(POST), true)
  assert.equal(isUuid(POST.toUpperCase()), true)
  for (const value of ['', 'abc', `${POST} `, `${POST}0`, POST.replaceAll('-', ''), null, undefined, 42]) {
    assert.equal(isUuid(value), false, `value=${String(value)}`)
  }
})

test('isMissingColumnError matches the Postgres and PostgREST missing-column codes', () => {
  const pg = { code: '42703', message: 'column study_groups.deleted_at does not exist' }
  const rest = { code: 'PGRST204', message: "Could not find the 'deleted_at' column of 'study_groups' in the schema cache" }
  assert.equal(isMissingColumnError(pg), true)
  assert.equal(isMissingColumnError(pg, 'deleted_at'), true)
  assert.equal(isMissingColumnError(rest, 'deleted_at'), true)
  assert.equal(isMissingColumnError(pg, 'edited_at'), false)
  assert.equal(isMissingColumnError({ code: '42P01', message: 'relation "study_groups" does not exist' }), false)
  assert.equal(isMissingColumnError({ code: '22P02', message: 'invalid input syntax for type uuid' }), false)
  assert.equal(isMissingColumnError(null), false)
})

test('selectLiveRows keeps the live filter when the column exists', async () => {
  const seen = []
  const result = await selectLiveRows(async (liveOnly) => {
    seen.push(liveOnly)
    return { data: [{ id: POST }], error: null }
  })
  assert.deepEqual(seen, [true])
  assert.deepEqual(result.data, [{ id: POST }])
})

test('selectLiveRows retries without the filter before the deleted_at migration runs', async () => {
  const seen = []
  const result = await selectLiveRows(async (liveOnly) => {
    seen.push(liveOnly)
    if (liveOnly) return { data: null, error: { code: '42703', message: 'column study_groups.deleted_at does not exist' } }
    return { data: [{ id: POST }], error: null }
  })
  assert.deepEqual(seen, [true, false])
  assert.deepEqual(result, { data: [{ id: POST }], error: null })
})

test('selectLiveRows does not retry on unrelated errors', async () => {
  const seen = []
  const failure = { code: '42P01', message: 'relation "study_groups" does not exist' }
  const result = await selectLiveRows(async (liveOnly) => {
    seen.push(liveOnly)
    return { data: null, error: failure }
  })
  assert.deepEqual(seen, [true])
  assert.equal(result.error, failure)
})
