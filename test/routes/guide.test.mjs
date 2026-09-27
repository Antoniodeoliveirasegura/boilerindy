import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createGuideRouter } from '../../src/routes/guide.mjs'
import { BOARD_PROFANITY_USER_MESSAGE } from '../../src/boardProfanity.mjs'
import { mapGuideRow } from '../../src/guideRecommendations.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the Neighborhood Guide routes as a feature router, booted on a
// small app with a fake session, recording limiters, a recording database and
// a fake of the community counters the upvote toggle recounts through.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com' }
const OTHER = '22222222-2222-4222-8222-222222222222'
const ADMIN = { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.com', is_admin: true }
const REC_ID = '66666666-6666-4666-8666-666666666666'
const REC_2 = '77777777-7777-4777-8777-777777777777'

function recRow(overrides = {}) {
  return {
    id: REC_ID,
    user_id: STUDENT.id,
    category: 'food',
    title: 'Taco truck on Michigan St',
    body: 'Cheap and fast',
    place_name: 'Taco truck',
    lat: null,
    lng: null,
    upvote_count: 3,
    pinned: false,
    created_at: '2026-09-10T12:00:00.000Z',
    ...overrides,
  }
}

const isUserAdmin = (user) => user?.is_admin === true

async function withApp({ user = STUDENT, handlers = {}, counts = [4] } = {}, run) {
  const supabase = fakeSupabase({
    guide_recommendations: () => ({ data: [], error: null }),
    guide_upvotes: () => ({ data: null, error: null }),
    ...handlers,
  })
  const limiterHits = []
  const recounts = []
  const communityCounters = {
    async syncGuideRecUpvotes(recId) {
      recounts.push(recId)
      return { count: counts[Math.min(recounts.length - 1, counts.length - 1)], error: null }
    },
  }
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(
    createGuideRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      // Same gate as server.mjs requireAdmin.
      requireAdmin: (req, res, next) => {
        if (!isUserAdmin(req.currentUser)) return res.status(403).json({ error: { message: 'Admin access required.', status: 403 } })
        next()
      },
      isUserAdmin,
      communityCounters,
      boardWriteRateLimit: limiter('boardWriteRateLimit'),
      userWriteRateLimit: limiter('userWriteRateLimit'),
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
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  try {
    await run({ call, supabase, limiterHits, recounts })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const NEW_REC = { category: 'Food', title: 'Taco truck on Michigan St', body: 'Cheap and fast', placeName: 'Taco truck' }

test('every route sits behind requireAuth', async () => {
  await withApp({ user: null }, async ({ call, supabase }) => {
    for (const [method, path] of [
      ['GET', '/api/guide'],
      ['POST', '/api/guide'],
      ['POST', `/api/guide/${REC_ID}/upvote`],
      ['PATCH', `/api/guide/${REC_ID}/pin`],
      ['DELETE', `/api/guide/${REC_ID}`],
    ]) {
      const answer = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : NEW_REC)
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('each write passes its limiter: board-write for create and upvote, user-write for pin and delete', async () => {
  const handlers = {
    guide_recommendations: (chain) => {
      const op = operation(chain)
      if (op === 'insert') return { data: recRow(), error: null }
      if (op === 'update') return { data: [{ id: REC_ID }], error: null }
      return { data: hasCall(chain, 'maybeSingle') ? { id: REC_ID } : [], error: null }
    },
  }
  await withApp({ user: ADMIN, handlers }, async ({ call, limiterHits }) => {
    assert.equal((await call('GET', '/api/guide')).status, 200)
    assert.equal((await call('POST', '/api/guide', NEW_REC)).status, 201)
    assert.equal((await call('POST', `/api/guide/${REC_ID}/upvote`)).status, 200)
    assert.equal((await call('PATCH', `/api/guide/${REC_ID}/pin`, { pinned: true })).status, 200)
    assert.equal((await call('DELETE', `/api/guide/${REC_ID}`)).status, 204)
    assert.deepEqual(limiterHits, [
      'boardWriteRateLimit POST /api/guide',
      `boardWriteRateLimit POST /api/guide/${REC_ID}/upvote`,
      `userWriteRateLimit PATCH /api/guide/${REC_ID}/pin`,
      `userWriteRateLimit DELETE /api/guide/${REC_ID}`,
    ])
  })
})

test('GET lists live recommendations pinned first and marks the caller\'s upvotes', async () => {
  const rows = [recRow({ pinned: true }), recRow({ id: REC_2, user_id: OTHER, upvote_count: 9 })]
  const handlers = {
    guide_recommendations: () => ({ data: rows, error: null }),
    guide_upvotes: () => ({ data: [{ rec_id: REC_2 }], error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/guide?category=%20Food%20')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { recommendations: rows.map((r) => mapGuideRow(r, STUDENT.id, new Set([REC_2]))) })
    assert.equal(answer.body.recommendations[0].isMine, true)
    assert.equal(answer.body.recommendations[1].upvotedByMe, true)

    const [list] = supabase.queriesOf('guide_recommendations')
    assert.ok(hasCall(list.chain, 'is', 'deleted_at', null))
    assert.deepEqual(list.chain.filter((c) => c.method === 'order').map((c) => c.args[0]), ['pinned', 'upvote_count', 'created_at'])
    assert.ok(hasCall(list.chain, 'limit', 200))
    assert.ok(hasCall(list.chain, 'eq', 'category', 'food'))
    const [votes] = supabase.queriesOf('guide_upvotes')
    assert.ok(hasCall(votes.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(votes.chain, 'in', 'rec_id', [REC_ID, REC_2]))
  })
})

test('GET skips the upvote lookup for an empty list', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/guide')
    assert.deepEqual(answer.body, { recommendations: [] })
    assert.equal(supabase.queriesOf('guide_upvotes').length, 0)
  })
})

test('POST validates, runs the profanity policy and inserts for the caller', async () => {
  const handlers = { guide_recommendations: () => ({ data: recRow(), error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const badCategory = await call('POST', '/api/guide', { ...NEW_REC, category: 'bars' })
    assert.equal(badCategory.status, 400)
    assert.deepEqual(badCategory.body, { error: { message: 'Category must be one of: food, study, parking, safety, other', status: 400 } })
    const noTitle = await call('POST', '/api/guide', { ...NEW_REC, title: ' ' })
    assert.deepEqual(noTitle.body, { error: { message: 'Title is required (max 120 characters)', status: 400 } })
    const profane = await call('POST', '/api/guide', { ...NEW_REC, body: 'what an asshole' })
    assert.equal(profane.status, 400)
    assert.deepEqual(profane.body, { error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const created = await call('POST', '/api/guide', NEW_REC)
    assert.equal(created.status, 201)
    assert.deepEqual(created.body, { recommendation: mapGuideRow(recRow(), STUDENT.id) })
    const [{ chain }] = supabase.queriesOf('guide_recommendations')
    assert.ok(
      hasCall(chain, 'insert', {
        user_id: STUDENT.id,
        category: 'food',
        title: 'Taco truck on Michigan St',
        body: 'Cheap and fast',
        place_name: 'Taco truck',
        lat: null,
        lng: null,
      }),
    )
  })
})

test('upvote inserts a vote, a 23505 duplicate removes it, and each toggle recounts through the counters', async () => {
  let voteExists = false
  const handlers = {
    guide_recommendations: () => ({ data: { id: REC_ID }, error: null }),
    guide_upvotes: (chain) => {
      if (operation(chain) === 'insert') {
        if (voteExists) return { data: null, error: { code: '23505', message: 'duplicate key value' } }
        voteExists = true
        return { data: null, error: null }
      }
      if (operation(chain) === 'delete') voteExists = false
      return { data: null, error: null }
    },
  }
  await withApp({ handlers, counts: [4, 3] }, async ({ call, supabase, recounts }) => {
    const first = await call('POST', `/api/guide/${REC_ID}/upvote`)
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { upvotes: 4, upvotedByMe: true })
    const [insert] = supabase.queriesOf('guide_upvotes')
    const values = insert.chain.find((c) => c.method === 'insert').args[0]
    assert.equal(values.rec_id, REC_ID)
    assert.equal(values.user_id, STUDENT.id)
    assert.ok(!Number.isNaN(Date.parse(values.created_at)), 'the vote row carries an ISO timestamp')

    const second = await call('POST', `/api/guide/${REC_ID}/upvote`)
    assert.deepEqual(second.body, { upvotes: 3, upvotedByMe: false })
    const removal = supabase.queriesOf('guide_upvotes').find((q) => operation(q.chain) === 'delete')
    assert.ok(hasCall(removal.chain, 'eq', 'rec_id', REC_ID))
    assert.ok(hasCall(removal.chain, 'eq', 'user_id', STUDENT.id))
    assert.deepEqual(recounts, [REC_ID, REC_ID])

    const lookup = supabase.queriesOf('guide_recommendations')[0]
    assert.ok(hasCall(lookup.chain, 'is', 'deleted_at', null), 'a deleted recommendation cannot be upvoted')
  })
})

test('upvote answers 404 for a missing or deleted recommendation without voting', async () => {
  const handlers = { guide_recommendations: () => ({ data: null, error: null }) }
  await withApp({ handlers }, async ({ call, supabase, recounts }) => {
    const answer = await call('POST', `/api/guide/${REC_ID}/upvote`)
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, { error: { message: 'Recommendation not found.', status: 404 } })
    assert.equal(supabase.queriesOf('guide_upvotes').length, 0)
    assert.equal(recounts.length, 0)
  })
})

test('pin is admin only: 403 for a student, the update for an admin, 404 when nothing matched', async () => {
  let rows = [{ id: REC_ID }]
  const handlers = { guide_recommendations: () => ({ data: rows, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('PATCH', `/api/guide/${REC_ID}/pin`, { pinned: true })
    assert.equal(answer.status, 403)
    assert.deepEqual(answer.body, { error: { message: 'Admin access required.', status: 403 } })
    assert.equal(supabase.queries.length, 0)
  })
  await withApp({ user: ADMIN, handlers }, async ({ call, supabase }) => {
    const pinned = await call('PATCH', `/api/guide/${REC_ID}/pin`, { pinned: 'true' })
    assert.equal(pinned.status, 200)
    assert.deepEqual(pinned.body, { ok: true, pinned: true })
    const [{ chain }] = supabase.queriesOf('guide_recommendations')
    assert.ok(hasCall(chain, 'update', { pinned: true }))
    assert.ok(hasCall(chain, 'eq', 'id', REC_ID))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))

    const unpinned = await call('PATCH', `/api/guide/${REC_ID}/pin`, {})
    assert.deepEqual(unpinned.body, { ok: true, pinned: false })

    rows = []
    const missing = await call('PATCH', `/api/guide/${REC_ID}/pin`, { pinned: true })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Recommendation not found.', status: 404 } })
  })
})

test('DELETE runs through ownerOrAdminScope: a student is scoped to their rows, an admin is not', async () => {
  let rows = [{ id: REC_ID }]
  const handlers = { guide_recommendations: () => ({ data: rows, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('DELETE', `/api/guide/${REC_ID}`)
    assert.equal(answer.status, 204)
    const [{ chain }] = supabase.queriesOf('guide_recommendations')
    const values = chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(values), ['deleted_at'])
    assert.ok(hasCall(chain, 'eq', 'id', REC_ID))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(chain, 'select', 'id'))

    rows = []
    const missing = await call('DELETE', `/api/guide/${REC_ID}`)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Recommendation not found or not yours.', status: 404 } })
  })
  rows = [{ id: REC_ID }]
  await withApp({ user: ADMIN, handlers }, async ({ call, supabase }) => {
    assert.equal((await call('DELETE', `/api/guide/${REC_ID}`)).status, 204)
    assert.ok(!hasCall(supabase.queriesOf('guide_recommendations')[0].chain, 'eq', 'user_id'), 'an admin takedown has no owner filter')
  })
})

test('database failures: guide_schema_missing for a missing table or deleted_at column, 500 otherwise', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const schemaMissing = { error: { message: 'The Neighborhood Guide is not set up yet. Please try again later.', code: 'guide_schema_missing', status: 503 } }

  const noTable = { guide_recommendations: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.guide_recommendations' in the schema cache" } }) }
  await withApp({ handlers: noTable }, async ({ call }) => {
    const answer = await call('GET', '/api/guide')
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, schemaMissing)
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-neighborhood-guide\.sql/)

  const noColumn = { guide_recommendations: () => ({ data: null, error: { code: '42703', message: 'column guide_recommendations.deleted_at does not exist' } }) }
  await withApp({ handlers: noColumn }, async ({ call }) => {
    const answer = await call('DELETE', `/api/guide/${REC_ID}`)
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, schemaMissing)
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-soft-delete\.sql/, 'the log names the soft-delete migration')

  const broken = { guide_recommendations: () => ({ data: null, error: { code: '23514', message: 'check constraint' } }) }
  await withApp({ handlers: broken }, async ({ call }) => {
    const answer = await call('POST', '/api/guide', NEW_REC)
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not load the guide. Please try again.', status: 500 } })
  })
})

test('a malformed :id answers the 404 envelope before any query', async () => {
  await withApp({ user: ADMIN }, async ({ call, supabase }) => {
    for (const [method, path] of [
      ['POST', '/api/guide/not-a-uuid/upvote'],
      ['PATCH', '/api/guide/not-a-uuid/pin'],
      ['DELETE', '/api/guide/not-a-uuid'],
    ]) {
      const answer = await call(method, path, method === 'PATCH' ? { pinned: true } : undefined)
      assert.equal(answer.status, 404, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'Not found.', status: 404 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})
