import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createBlocksRouter } from '../../src/routes/blocks.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #192: the block routes as a feature router. It boots here on a small
// app with a fake session, a recording limiter and a recording database, the
// way server.mjs mounts it with the real ones.

const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'me@purdue.edu' }
const OTHER = '22222222-2222-4222-8222-222222222222'
const THIRD = '33333333-3333-4333-8333-333333333333'
const CONTENT = '44444444-4444-4444-8444-444444444444'
const LIMIT_MESSAGE = 'You have reached the limit of blocked users.'
const ANONYMOUS_MESSAGE = 'Anonymous posts cannot be blocked. Report it instead.'
const NOT_FOUND = { error: { message: 'Not found.', status: 404 } }

const ROUTES = [
  ['GET', '/api/me/blocks'],
  ['POST', `/api/me/blocks/${OTHER}`],
  ['POST', `/api/me/blocks/content/board_post/${CONTENT}`],
  ['DELETE', `/api/me/blocks/${OTHER}`],
]

// blocked_users as the routes use it: the caller's head count, their list, the
// insert and the delete.
function blocksTable({ count = 0, rows = [], insertError = null, error = null } = {}) {
  return (chain) => {
    if (error) return { data: null, error }
    const op = operation(chain)
    if (op === 'insert') return { data: null, error: insertError }
    if (op === 'delete') return { data: null, error: null }
    if (hasCall(chain, 'select', 'blocked_id', { count: 'exact', head: true })) return { data: null, count, error: null }
    return { data: rows, error: null }
  }
}

async function withApp({ user = ME, handlers = {} } = {}, run) {
  const supabase = fakeSupabase({
    blocked_users: blocksTable(),
    users: () => ({ data: { id: OTHER }, error: null }),
    connections: () => ({ data: null, error: null }),
    ...handlers,
  })
  const limiterHits = []
  const app = express()
  app.use(express.json())
  app.use(
    createBlocksRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      userWriteRateLimit: (req, _res, next) => {
        limiterHits.push(`userWriteRateLimit ${req.method} ${req.path}`)
        next()
      },
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    await run({ call, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// The block itself: one row for the pair, then the pair's connections deleted
// whichever of them asked.
function assertBlocked(supabase, blockedId) {
  const insert = supabase.queriesOf('blocked_users').find((q) => operation(q.chain) === 'insert')
  assert.ok(insert, 'expected a blocked_users insert')
  assert.ok(hasCall(insert.chain, 'insert', { blocker_id: ME.id, blocked_id: blockedId }))
  const [cleanup] = supabase.queriesOf('connections')
  assert.equal(operation(cleanup.chain), 'delete')
  assert.ok(
    hasCall(
      cleanup.chain,
      'or',
      `and(requester_id.eq.${ME.id},addressee_id.eq.${blockedId}),and(requester_id.eq.${blockedId},addressee_id.eq.${ME.id})`,
    ),
  )
}

function assertNotBlocked(supabase) {
  assert.equal(supabase.queriesOf('blocked_users').filter((q) => operation(q.chain) === 'insert').length, 0)
  assert.equal(supabase.queriesOf('connections').length, 0)
}

test('every route sits behind requireAuth', async () => {
  await withApp({ user: null }, async ({ call, supabase }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path)
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('the three writes pass user-write under the server.mjs name, the list does not', async () => {
  await withApp({ handlers: { board_posts: () => ({ data: null, error: null }) } }, async ({ call, limiterHits }) => {
    for (const [method, path] of ROUTES) await call(method, path)
    assert.deepEqual(limiterHits, [
      `userWriteRateLimit POST /api/me/blocks/${OTHER}`,
      `userWriteRateLimit POST /api/me/blocks/content/board_post/${CONTENT}`,
      `userWriteRateLimit DELETE /api/me/blocks/${OTHER}`,
    ])
  })
})

test('the list shows my own blocks newest first, named through one users lookup', async () => {
  const rows = [
    { blocked_id: OTHER, created_at: '2026-09-27T10:00:00.000Z' },
    { blocked_id: THIRD, created_at: '2026-09-26T10:00:00.000Z' },
  ]
  const handlers = {
    blocked_users: blocksTable({ rows }),
    users: () => ({ data: [{ id: OTHER, display_name: 'Casey Park' }], error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/blocks')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, {
      blocks: [
        { userId: OTHER, displayName: 'Casey Park', createdAt: '2026-09-27T10:00:00.000Z' },
        // No display name reads as "Student", as on every other surface.
        { userId: THIRD, displayName: 'Student', createdAt: '2026-09-26T10:00:00.000Z' },
      ],
    })
    const [list] = supabase.queriesOf('blocked_users')
    assert.ok(hasCall(list.chain, 'eq', 'blocker_id', ME.id))
    assert.ok(!hasCall(list.chain, 'or'), 'blocks by other people only take effect, they are never listed')
    assert.ok(hasCall(list.chain, 'order', 'created_at', { ascending: false }))
    assert.ok(hasCall(list.chain, 'limit', 500))
    const [names] = supabase.queriesOf('users')
    assert.ok(hasCall(names.chain, 'in', 'id', [OTHER, THIRD]))
  })
  await withApp({}, async ({ call, supabase }) => {
    assert.deepEqual((await call('GET', '/api/me/blocks')).body, { blocks: [] })
    assert.equal(supabase.queriesOf('users').length, 0, 'no name lookup for an empty list')
  })
})

test('blocking a user refuses myself, an unknown user and a block past the limit, before writing', async () => {
  await withApp({}, async ({ call, supabase }) => {
    // An uppercase copy of my own id is still me.
    const self = await call('POST', `/api/me/blocks/${ME.id.toUpperCase()}`)
    assert.equal(self.status, 400)
    assert.deepEqual(self.body, { error: { message: 'You cannot block yourself.', status: 400 } })
    const malformed = await call('POST', '/api/me/blocks/not-a-uuid')
    assert.equal(malformed.status, 404)
    assert.deepEqual(malformed.body, NOT_FOUND)
    assert.equal(supabase.queries.length, 0)
  })
  await withApp({ handlers: { users: () => ({ data: null, error: null }) } }, async ({ call, supabase }) => {
    const unknown = await call('POST', `/api/me/blocks/${OTHER}`)
    assert.equal(unknown.status, 404)
    assert.deepEqual(unknown.body, { error: { message: 'User not found.', status: 404 } })
    assertNotBlocked(supabase)
  })
  await withApp({ handlers: { blocked_users: blocksTable({ count: 500 }) } }, async ({ call, supabase }) => {
    const full = await call('POST', `/api/me/blocks/${OTHER}`)
    assert.equal(full.status, 400)
    assert.deepEqual(full.body, { error: { message: LIMIT_MESSAGE, status: 400 } })
    const [count] = supabase.queriesOf('blocked_users')
    assert.ok(hasCall(count.chain, 'eq', 'blocker_id', ME.id), 'only my own blocks count toward my limit')
    assertNotBlocked(supabase)
  })
})

test('blocking a user writes the row and removes our connections both ways, and a repeat is still ok', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('POST', `/api/me/blocks/${OTHER.toUpperCase()}`)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    const [target] = supabase.queriesOf('users')
    assert.ok(hasCall(target.chain, 'eq', 'id', OTHER))
    assertBlocked(supabase, OTHER)
  })
  const duplicate = { code: '23505', message: 'duplicate key value violates unique constraint "blocked_users_pkey"' }
  await withApp({ handlers: { blocked_users: blocksTable({ insertError: duplicate }) } }, async ({ call, supabase }) => {
    const again = await call('POST', `/api/me/blocks/${OTHER}`)
    assert.equal(again.status, 200)
    assert.deepEqual(again.body, { ok: true })
    assertBlocked(supabase, OTHER)
  })
})

test('blocking by content refuses a type it cannot block by, and checks the limit before any lookup', async () => {
  await withApp({}, async ({ call, supabase }) => {
    for (const type of ['user', 'deals', 'BOARD_POST']) {
      const answer = await call('POST', `/api/me/blocks/content/${type}/${CONTENT}`)
      assert.equal(answer.status, 404, type)
      assert.deepEqual(answer.body, NOT_FOUND)
    }
    const malformed = await call('POST', '/api/me/blocks/content/board_post/not-a-uuid')
    assert.equal(malformed.status, 404)
    assert.equal(supabase.queries.length, 0)
  })
  await withApp({ handlers: { blocked_users: blocksTable({ count: 500 }) } }, async ({ call, supabase }) => {
    const full = await call('POST', `/api/me/blocks/content/guide/${CONTENT}`)
    assert.equal(full.status, 400)
    assert.deepEqual(full.body, { error: { message: LIMIT_MESSAGE, status: 400 } })
    assert.equal(supabase.queriesOf('guide_recommendations').length, 0, 'the limit answers before the content is read')
  })
})

test('blocking by content resolves the author server-side through the type\'s table and column', async () => {
  const cases = [
    ['board_post', 'board_posts', 'id, user_id, is_anon', { id: CONTENT, user_id: OTHER, is_anon: false }],
    ['board_reply', 'board_replies', 'id, user_id, is_anon', { id: CONTENT, user_id: OTHER, is_anon: false }],
    ['lost_found', 'lost_found_items', 'id, user_id', { id: CONTENT, user_id: OTHER }],
    ['guide', 'guide_recommendations', 'id, user_id', { id: CONTENT, user_id: OTHER }],
    ['study_group', 'study_groups', 'id, creator_id', { id: CONTENT, creator_id: OTHER }],
    ['marketplace', 'marketplace_listings', 'id, user_id', { id: CONTENT, user_id: OTHER }],
  ]
  for (const [type, table, columns, row] of cases) {
    await withApp({ handlers: { [table]: () => ({ data: row, error: null }) } }, async ({ call, supabase }) => {
      const answer = await call('POST', `/api/me/blocks/content/${type}/${CONTENT.toUpperCase()}`)
      assert.equal(answer.status, 200, type)
      assert.deepEqual(answer.body, { ok: true })
      const [lookup] = supabase.queriesOf(table)
      assert.ok(hasCall(lookup.chain, 'select', columns), type)
      assert.ok(hasCall(lookup.chain, 'eq', 'id', CONTENT), type)
      assertBlocked(supabase, OTHER)
    })
  }
})

test('blocking by content answers the same ok, blocking nobody, for content that is gone, mine or not installed', async () => {
  const outcomes = [
    ['gone', () => ({ data: null, error: null })],
    ['mine', () => ({ data: { id: CONTENT, user_id: ME.id }, error: null })],
    ['not installed', () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.lost_found_items' in the schema cache" } })],
  ]
  for (const [label, handler] of outcomes) {
    await withApp({ handlers: { lost_found_items: handler } }, async ({ call, supabase }) => {
      const answer = await call('POST', `/api/me/blocks/content/lost_found/${CONTENT}`)
      assert.equal(answer.status, 200, label)
      assert.deepEqual(answer.body, { ok: true }, label)
      assertNotBlocked(supabase)
    })
  }
})

test('anonymous board posts and replies cannot be blocked, only reported (owner decision, 2026-09-27)', async () => {
  for (const [type, table] of [['board_post', 'board_posts'], ['board_reply', 'board_replies']]) {
    const handlers = { [table]: () => ({ data: { id: CONTENT, user_id: OTHER, is_anon: true }, error: null }) }
    await withApp({ handlers }, async ({ call, supabase }) => {
      const answer = await call('POST', `/api/me/blocks/content/${type}/${CONTENT}`)
      assert.equal(answer.status, 400, type)
      assert.deepEqual(answer.body, { error: { message: ANONYMOUS_MESSAGE, status: 400 } })
      assertNotBlocked(supabase)
    })
  }
})

test('unblocking removes only my own block, is ok when there was none, and brings no connection back', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('DELETE', `/api/me/blocks/${OTHER.toUpperCase()}`)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    const [removal] = supabase.queriesOf('blocked_users')
    assert.equal(operation(removal.chain), 'delete')
    assert.ok(hasCall(removal.chain, 'eq', 'blocker_id', ME.id))
    assert.ok(hasCall(removal.chain, 'eq', 'blocked_id', OTHER))
    assert.equal(supabase.queriesOf('connections').length, 0)
  })
})

test('database failures answer blocked_users_schema_missing before step 38 runs, and the blocked users fallback otherwise', async () => {
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.blocked_users' in the schema cache" }
  await withApp({ handlers: { blocked_users: blocksTable({ error: missing }) } }, async ({ call }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path)
      assert.equal(answer.status, 503, `${method} ${path}`)
      assert.equal(answer.body.error.code, 'blocked_users_schema_missing')
    }
  })
  const timeout = { code: '57014', message: 'canceling statement due to statement timeout' }
  await withApp({ handlers: { blocked_users: blocksTable({ error: timeout }) } }, async ({ call }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path)
      assert.equal(answer.status, 500, `${method} ${path}`)
      assert.equal(answer.body.error.message, 'Could not update your blocked users. Please try again.')
    }
  })
})
