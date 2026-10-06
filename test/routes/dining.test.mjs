import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createDiningPublicRouter, createDiningRouter } from '../../src/routes/dining.mjs'
import { DINING_FAVORITES_CAP_MESSAGE, MAX_DINING_FAVORITES } from '../../src/userWriteCaps.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the dining routes as feature routers, booted on a small app with
// recording limiters, a fake Nutrislice snapshot, a fake session and a
// recording database. The public snapshot router takes no session at all,
// which is the point of mounting it ahead of the session middleware (#250).

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com' }

async function serve(app, run) {
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await run(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function withPublicApp({ snapshot = async () => ({ ok: true, locations: [{ name: 'Tower Dining' }] }) } = {}, run) {
  const limiterHits = []
  const snapshotCalls = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(
    createDiningPublicRouter({
      publicReadIpRateLimit: limiter('public-read-ip'),
      publicReadRateLimit: limiter('public-read'),
      getDiningSnapshot: async (options) => {
        snapshotCalls.push(options)
        return snapshot(options)
      },
    }),
  )
  await serve(app, (base) => run({ base, limiterHits, snapshotCalls }))
}

async function withApp({ user = STUDENT, table = () => ({ data: [], error: null }) } = {}, run) {
  const supabase = fakeSupabase({ user_dining_favorites: table })
  const limiterHits = []
  const app = express()
  app.use(express.json())
  app.use(
    createDiningRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      userWriteRateLimit: (req, _res, next) => {
        limiterHits.push(`${req.method} ${req.path}`)
        next()
      },
    }),
  )
  await serve(app, async (base) => {
    const call = async (method, path, body) => {
      const response = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }
    await run({ call, supabase, limiterHits })
  })
}

// ── GET /api/dining ─────────────────────────────────────────────────────────

test('the snapshot is served through both public-read limiters and cached at the edge', async () => {
  await withPublicApp({}, async ({ base, limiterHits, snapshotCalls }) => {
    const res = await fetch(`${base}/api/dining`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, locations: [{ name: 'Tower Dining' }] })
    assert.equal(res.headers.get('cache-control'), 'public, max-age=120, s-maxage=300')
    assert.equal(res.headers.get('set-cookie'), null)
    assert.deepEqual(snapshotCalls, [{ forceRefresh: false, date: undefined }])
    assert.deepEqual(limiterHits, ['public-read-ip GET /api/dining', 'public-read GET /api/dining'])
  })
})

test('a forced refresh and an outage snapshot are never cached', async () => {
  await withPublicApp({}, async ({ base, snapshotCalls }) => {
    const res = await fetch(`${base}/api/dining?refresh=1`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(snapshotCalls, [{ forceRefresh: true, date: undefined }])
  })
  await withPublicApp({ snapshot: async () => ({ ok: false, locations: [] }) }, async ({ base }) => {
    const res = await fetch(`${base}/api/dining`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })
})

test('a date inside the window reaches the snapshot; anything else is a 400', async () => {
  // UTC today is today or tomorrow in Indianapolis, both inside the window.
  const today = new Date().toISOString().slice(0, 10)
  await withPublicApp({}, async ({ base, snapshotCalls }) => {
    const ok = await fetch(`${base}/api/dining?date=${today}`)
    assert.equal(ok.status, 200)
    assert.deepEqual(snapshotCalls, [{ forceRefresh: false, date: today }])

    for (const bad of ['bogus', '2020-01-01', '2026-02-30']) {
      const res = await fetch(`${base}/api/dining?date=${bad}`)
      assert.equal(res.status, 400, bad)
      assert.deepEqual(await res.json(), { ok: false, error: 'dining_bad_date', locations: [] })
    }
    assert.equal(snapshotCalls.length, 1, 'a rejected date never reaches the snapshot')
  })
})

test('a snapshot that throws answers dining_internal', async () => {
  const snapshot = async () => {
    throw new Error('Nutrislice down')
  }
  await withPublicApp({ snapshot }, async ({ base }) => {
    const res = await fetch(`${base}/api/dining`)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { ok: false, error: 'dining_internal', locations: [] })
  })
})

// ── /api/me/dining/favorites ────────────────────────────────────────────────

test('favorites need a signed-in student', async () => {
  await withApp({ user: null }, async ({ call, supabase }) => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await call(method, '/api/me/dining/favorites', method === 'GET' ? undefined : { itemName: 'Pho' })
      assert.equal(res.status, 401, method)
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test("GET lists the student's own favorites, oldest first", async () => {
  const table = () => ({ data: [{ item_name: 'pho' }, { item_name: 'chicken tikka' }], error: null })
  await withApp({ table }, async ({ call, supabase }) => {
    const res = await call('GET', '/api/me/dining/favorites')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { favorites: ['pho', 'chicken tikka'] })
    const [query] = supabase.queriesOf('user_dining_favorites')
    assert.ok(hasCall(query.chain, 'select', 'item_name'))
    assert.ok(hasCall(query.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(query.chain, 'order', 'created_at', { ascending: true }))
  })
})

test('GET degrades to an empty list when the table cannot be read', async () => {
  const table = () => ({ data: null, error: { message: 'relation "user_dining_favorites" does not exist', code: '42P01' } })
  await withApp({ table }, async ({ call }) => {
    const res = await call('GET', '/api/me/dining/favorites')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { favorites: [], unavailable: true })
  })
})

test('POST normalizes the name, counts the other favorites and upserts behind the write limiter', async () => {
  const table = (chain) => (operation(chain) === 'select' ? { data: null, error: null, count: 3 } : { data: null, error: null })
  await withApp({ table }, async ({ call, supabase, limiterHits }) => {
    const res = await call('POST', '/api/me/dining/favorites', { itemName: '  Chicken   Tikka ' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, itemName: 'chicken tikka' })
    const [count, upsert] = supabase.queriesOf('user_dining_favorites')
    assert.ok(hasCall(count.chain, 'select', 'item_name', { count: 'exact', head: true }))
    assert.ok(hasCall(count.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(count.chain, 'neq', 'item_name', 'chicken tikka'))
    assert.ok(hasCall(upsert.chain, 'upsert', { user_id: STUDENT.id, item_name: 'chicken tikka' }, { onConflict: 'user_id,item_name' }))
    assert.deepEqual(limiterHits, ['POST /api/me/dining/favorites'])
  })
})

test('POST at the cap answers 409 and writes nothing', async () => {
  const table = (chain) => (operation(chain) === 'select' ? { data: null, error: null, count: MAX_DINING_FAVORITES } : { data: null, error: null })
  await withApp({ table }, async ({ call, supabase }) => {
    const res = await call('POST', '/api/me/dining/favorites', { itemName: 'Pho' })
    assert.equal(res.status, 409)
    assert.deepEqual(res.body, { error: { message: DINING_FAVORITES_CAP_MESSAGE, status: 409 } })
    assert.equal(supabase.queriesOf('user_dining_favorites').length, 1, 'only the count query ran')
  })
})

test('POST and DELETE without an item name answer 400', async () => {
  await withApp({}, async ({ call, supabase }) => {
    for (const method of ['POST', 'DELETE']) {
      const res = await call(method, '/api/me/dining/favorites', { itemName: '   ' })
      assert.equal(res.status, 400, method)
      assert.deepEqual(res.body, { error: { message: 'An item name is required', status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('DELETE removes only that item for that student, by body or query string', async () => {
  await withApp({}, async ({ call, supabase, limiterHits }) => {
    const byBody = await call('DELETE', '/api/me/dining/favorites', { itemName: 'Pho' })
    assert.equal(byBody.status, 200)
    assert.deepEqual(byBody.body, { ok: true })
    const byQuery = await call('DELETE', '/api/me/dining/favorites?itemName=Chicken%20Tikka')
    assert.equal(byQuery.status, 200)
    const [first, second] = supabase.queriesOf('user_dining_favorites')
    assert.equal(operation(first.chain), 'delete')
    assert.ok(hasCall(first.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(first.chain, 'eq', 'item_name', 'pho'))
    assert.ok(hasCall(second.chain, 'eq', 'item_name', 'chicken tikka'))
    assert.deepEqual(limiterHits, ['DELETE /api/me/dining/favorites', 'DELETE /api/me/dining/favorites'])
  })
})
