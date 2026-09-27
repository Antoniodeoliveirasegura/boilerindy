import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createLostFoundRouter } from '../../src/routes/lostFound.mjs'
import { BOARD_PROFANITY_USER_MESSAGE } from '../../src/boardProfanity.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the Lost & Found routes as a feature router. It boots here on a
// small app with a fake session, recording limiters and a recording database,
// the way server.mjs mounts it with the real ones.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com' }
const OTHER = '22222222-2222-4222-8222-222222222222'
const ADMIN = { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.com', is_admin: true }
const ITEM_ID = '44444444-4444-4444-8444-444444444444'

function row(overrides = {}) {
  return {
    id: ITEM_ID,
    user_id: STUDENT.id,
    type: 'lost',
    title: 'Blue water bottle',
    description: 'Left in the library',
    location: 'University Library',
    contact: 'dm me',
    status: 'open',
    created_at: '2026-09-20T10:00:00.000Z',
    updated_at: '2026-09-20T10:00:00.000Z',
    ...overrides,
  }
}

async function withApp({ user = STUDENT, table = () => ({ data: [], error: null }) } = {}, run) {
  const supabase = fakeSupabase({ lost_found_items: table })
  const limiterHits = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(
    createLostFoundRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      isUserAdmin: (u) => u?.is_admin === true,
      lostFoundWriteRateLimit: limiter('lostFoundWriteRateLimit'),
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
    return { status: response.status, body: await response.json() }
  }
  try {
    await run({ call, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('every route sits behind requireAuth', async () => {
  await withApp({ user: null }, async ({ call, supabase }) => {
    for (const [method, path] of [
      ['GET', '/api/lost-found'],
      ['POST', '/api/lost-found'],
      ['PATCH', `/api/lost-found/${ITEM_ID}`],
      ['DELETE', `/api/lost-found/${ITEM_ID}`],
    ]) {
      const answer = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : { type: 'lost', title: 'x' })
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0, 'no query runs for a signed-out caller')
  })
})

test('the writes pass their limiters, the read does not', async () => {
  await withApp(
    {
      table: (chain) => {
        const op = operation(chain)
        if (op === 'insert') return { data: row(), error: null }
        if (op === 'update') {
          const values = chain.find((c) => c.method === 'update').args[0]
          // The soft delete sets only deleted_at; an edit answers the updated row.
          return 'deleted_at' in values ? { data: [{ id: ITEM_ID }], error: null } : { data: row({ status: 'resolved' }), error: null }
        }
        return { data: hasCall(chain, 'maybeSingle') ? row() : [], error: null }
      },
    },
    async ({ call, limiterHits }) => {
      assert.equal((await call('GET', '/api/lost-found')).status, 200)
      assert.equal((await call('POST', '/api/lost-found', { type: 'lost', title: 'Keys' })).status, 201)
      assert.equal((await call('PATCH', `/api/lost-found/${ITEM_ID}`, { status: 'resolved' })).status, 200)
      assert.equal((await call('DELETE', `/api/lost-found/${ITEM_ID}`)).status, 200)
      assert.deepEqual(limiterHits, [
        'lostFoundWriteRateLimit POST /api/lost-found',
        `lostFoundWriteRateLimit PATCH /api/lost-found/${ITEM_ID}`,
        `userWriteRateLimit DELETE /api/lost-found/${ITEM_ID}`,
      ])
    },
  )
})

test('GET lists live items newest first, maps them for the caller and passes the sanitized q', async () => {
  const rows = [row(), row({ id: OTHER, user_id: OTHER, type: 'found', title: 'Umbrella' })]
  await withApp({ table: () => ({ data: rows, error: null }) }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/lost-found?type=found&status=open&q=' + encodeURIComponent('wallet%,user_id.eq.x)'))
    assert.equal(answer.status, 200)
    assert.equal(answer.body.items.length, 2)
    assert.deepEqual(answer.body.items[0], {
      id: ITEM_ID,
      type: 'lost',
      title: 'Blue water bottle',
      description: 'Left in the library',
      location: 'University Library',
      contact: 'dm me',
      status: 'open',
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
      isOwner: true,
    })
    assert.equal(answer.body.items[1].isOwner, false)

    const [{ chain }] = supabase.queriesOf('lost_found_items')
    assert.ok(hasCall(chain, 'select', '*'))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'order', 'created_at', { ascending: false }))
    assert.ok(hasCall(chain, 'limit', 200))
    assert.ok(hasCall(chain, 'eq', 'type', 'found'))
    assert.ok(hasCall(chain, 'eq', 'status', 'open'))
    // The separators are gone, so the term cannot open a second .or() clause.
    const term = 'wallet  user id.eq.x'
    assert.ok(hasCall(chain, 'or', `title.ilike.%${term}%,description.ilike.%${term}%,location.ilike.%${term}%`))
  })
})

test('GET ignores an unknown type or status and answers an empty, unavailable list on a failed query', async () => {
  await withApp({ table: () => ({ data: [], error: null }) }, async ({ call, supabase }) => {
    await call('GET', '/api/lost-found?type=stolen&status=deleted')
    const [{ chain }] = supabase.queriesOf('lost_found_items')
    assert.ok(!hasCall(chain, 'eq'), 'no type or status filter')
    assert.ok(!hasCall(chain, 'or'), 'no search filter')
  })
  await withApp({ table: () => ({ data: null, error: { message: 'relation "lost_found_items" does not exist', code: '42P01' } }) }, async ({ call }) => {
    const answer = await call('GET', '/api/lost-found')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { items: [], unavailable: true })
  })
})

test('POST validates the type, the title and the text policy before writing', async () => {
  await withApp({ table: () => ({ data: row(), error: null }) }, async ({ call, supabase }) => {
    const badType = await call('POST', '/api/lost-found', { type: 'stolen', title: 'Keys' })
    assert.equal(badType.status, 400)
    assert.deepEqual(badType.body, { error: { message: 'Type must be "lost" or "found".', status: 400 } })

    const noTitle = await call('POST', '/api/lost-found', { type: 'lost', title: '   ' })
    assert.equal(noTitle.status, 400)
    assert.deepEqual(noTitle.body, { error: { message: 'A short title is required.', status: 400 } })

    const profane = await call('POST', '/api/lost-found', { type: 'found', title: 'Keys', description: 'you bastard' })
    assert.equal(profane.status, 400)
    assert.deepEqual(profane.body, { error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })

    assert.equal(supabase.queries.length, 0, 'nothing is written for a rejected post')
  })
})

test('POST inserts an open item for the caller with trimmed, capped fields and answers 201', async () => {
  await withApp({ table: () => ({ data: row({ title: 'Keys' }), error: null }) }, async ({ call, supabase }) => {
    const answer = await call('POST', '/api/lost-found', {
      type: ' lost ',
      title: `  Keys  `,
      description: 'd'.repeat(2500),
      location: '',
      contact: 'text me',
    })
    assert.equal(answer.status, 201)
    assert.equal(answer.body.item.title, 'Keys')
    assert.equal(answer.body.item.isOwner, true)
    const [{ chain }] = supabase.queriesOf('lost_found_items')
    const insert = chain.find((c) => c.method === 'insert').args[0]
    assert.deepEqual(insert, {
      user_id: STUDENT.id,
      type: 'lost',
      title: 'Keys',
      description: 'd'.repeat(2000),
      location: null,
      contact: 'text me',
      status: 'open',
    })
    assert.ok(hasCall(chain, 'single'))
  })
})

test('POST keeps its 500 message on a failed insert', async () => {
  await withApp({ table: () => ({ data: null, error: { message: 'insert failed' } }) }, async ({ call }) => {
    const answer = await call('POST', '/api/lost-found', { type: 'lost', title: 'Keys' })
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not save your post. Please try again.', status: 500 } })
  })
})

test('PATCH answers 404 for a missing row or one that is not the caller\'s, without writing', async () => {
  await withApp({ table: () => ({ data: row({ user_id: OTHER }), error: null }) }, async ({ call, supabase }) => {
    const answer = await call('PATCH', `/api/lost-found/${ITEM_ID}`, { status: 'resolved' })
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, { error: { message: 'Post not found.', status: 404 } })
    assert.equal(supabase.queries.length, 1, 'only the lookup ran')
    assert.ok(hasCall(supabase.queries[0].chain, 'is', 'deleted_at', null))
  })
  await withApp({ table: () => ({ data: null, error: null }) }, async ({ call }) => {
    const answer = await call('PATCH', `/api/lost-found/${ITEM_ID}`, { status: 'resolved' })
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, { error: { message: 'Post not found.', status: 404 } })
  })
})

test('PATCH rejects an empty patch, an emptied title and profane text', async () => {
  await withApp({ table: () => ({ data: row(), error: null }) }, async ({ call }) => {
    const empty = await call('PATCH', `/api/lost-found/${ITEM_ID}`, { status: 'lost' })
    assert.equal(empty.status, 400)
    assert.deepEqual(empty.body, { error: { message: 'Nothing to update.', status: 400 } })

    const noTitle = await call('PATCH', `/api/lost-found/${ITEM_ID}`, { title: ' ' })
    assert.deepEqual(noTitle.body, { error: { message: 'Title cannot be empty.', status: 400 } })

    const profane = await call('PATCH', `/api/lost-found/${ITEM_ID}`, { location: 'bitch street' })
    assert.deepEqual(profane.body, { error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
  })
})

test('PATCH updates the caller\'s own live row and keeps its 500 message', async () => {
  const table = (chain) => (operation(chain) === 'update' ? { data: row({ status: 'resolved' }), error: null } : { data: row(), error: null })
  await withApp({ table }, async ({ call, supabase }) => {
    const answer = await call('PATCH', `/api/lost-found/${ITEM_ID}`, { status: 'resolved', contact: ' ' })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.item.status, 'resolved')
    const update = supabase.queriesOf('lost_found_items')[1].chain
    assert.ok(hasCall(update, 'update', { status: 'resolved', contact: null }))
    assert.ok(hasCall(update, 'eq', 'id', ITEM_ID))
    assert.ok(hasCall(update, 'eq', 'user_id', STUDENT.id))
  })
  const failing = (chain) => (operation(chain) === 'update' ? { data: null, error: { message: 'update failed' } } : { data: row(), error: null })
  await withApp({ table: failing }, async ({ call }) => {
    const answer = await call('PATCH', `/api/lost-found/${ITEM_ID}`, { status: 'resolved' })
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not update the post.', status: 500 } })
  })
})

test('DELETE soft-deletes through ownerOrAdminScope: a student is scoped to their rows, an admin is not', async () => {
  const table = () => ({ data: [{ id: ITEM_ID }], error: null })
  await withApp({ table }, async ({ call, supabase }) => {
    const answer = await call('DELETE', `/api/lost-found/${ITEM_ID}`)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    const [{ chain }] = supabase.queriesOf('lost_found_items')
    const update = chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(update), ['deleted_at'])
    assert.ok(!Number.isNaN(Date.parse(update.deleted_at)), 'deleted_at is an ISO timestamp')
    assert.ok(hasCall(chain, 'eq', 'id', ITEM_ID))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(chain, 'select', 'id'))
  })
  await withApp({ user: ADMIN, table }, async ({ call, supabase }) => {
    const answer = await call('DELETE', `/api/lost-found/${ITEM_ID}`)
    assert.equal(answer.status, 200)
    const [{ chain }] = supabase.queriesOf('lost_found_items')
    assert.ok(!hasCall(chain, 'eq', 'user_id'), 'an admin takedown has no owner filter')
  })
})

test('DELETE answers 404 when nothing was deleted and keeps its 500 message', async () => {
  await withApp({ table: () => ({ data: [], error: null }) }, async ({ call }) => {
    const answer = await call('DELETE', `/api/lost-found/${ITEM_ID}`)
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, { error: { message: 'Post not found.', status: 404 } })
  })
  await withApp({ table: () => ({ data: null, error: { message: 'update failed' } }) }, async ({ call }) => {
    const answer = await call('DELETE', `/api/lost-found/${ITEM_ID}`)
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not delete the post.', status: 500 } })
  })
})

test('a malformed :id answers the 404 envelope before any query (requireIdParam)', async () => {
  await withApp({}, async ({ call, supabase }) => {
    for (const method of ['PATCH', 'DELETE']) {
      const answer = await call(method, '/api/lost-found/not-a-uuid', method === 'PATCH' ? { status: 'resolved' } : undefined)
      assert.equal(answer.status, 404, method)
      assert.deepEqual(answer.body, { error: { message: 'Not found.', status: 404 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})
