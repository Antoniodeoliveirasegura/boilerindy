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

async function withPublicApp(
  {
    snapshot = async () => ({ ok: true, locations: [{ name: 'Tower Dining' }] }),
    food = async () => null,
    upcoming = async () => ({ ok: true, today: '2026-10-14', days: [] }),
  } = {},
  run,
) {
  const limiterHits = []
  const snapshotCalls = []
  const foodCalls = []
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
      findDiningFood: async (id, date) => {
        foodCalls.push([id, date])
        return food(id, date)
      },
      getDiningUpcoming: () => upcoming(),
    }),
  )
  await serve(app, (base) => run({ base, limiterHits, snapshotCalls, foodCalls }))
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

// ── GET /api/dining/foods/:id (issue #468) ──────────────────────────────────

const CHICKEN = { id: 2577937, name: 'Honey Garlic Fried Chicken', serving: '6 oz', nutrition: { calories: 326 }, icons: [] }

test('a dish on the menu is served through both public-read limiters and cached at the edge', async () => {
  const today = new Date().toISOString().slice(0, 10)
  await withPublicApp({ food: async () => CHICKEN }, async ({ base, limiterHits, foodCalls }) => {
    const res = await fetch(`${base}/api/dining/foods/2577937?date=${today}`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, date: today, food: CHICKEN })
    assert.equal(res.headers.get('cache-control'), 'public, max-age=600, s-maxage=3600')
    assert.equal(res.headers.get('set-cookie'), null)
    assert.deepEqual(foodCalls, [[2577937, today]])
    assert.deepEqual(limiterHits, ['public-read-ip GET /api/dining/foods/2577937', 'public-read GET /api/dining/foods/2577937'])
  })
})

test('without a date the dish is looked up for today on the Indianapolis calendar', async () => {
  await withPublicApp({ food: async () => CHICKEN }, async ({ base, foodCalls }) => {
    const res = await fetch(`${base}/api/dining/foods/2577937`)
    assert.equal(res.status, 200)
    assert.match(foodCalls[0][1], /^\d{4}-\d{2}-\d{2}$/)
  })
})

test('a bad id or date is a 400, a dish not on the menu a 404, a failure a 500, all in the envelope and never cached', async () => {
  await withPublicApp({ food: async () => null }, async ({ base, foodCalls }) => {
    for (const bad of ['abc', '12.5', '-3', '1234567890123']) {
      const res = await fetch(`${base}/api/dining/foods/${bad}`)
      assert.equal(res.status, 400, bad)
      assert.deepEqual(await res.json(), { error: { message: 'That is not a menu item.', status: 400, code: 'dining_bad_food' } })
    }
    for (const bad of ['bogus', '2020-01-01']) {
      const res = await fetch(`${base}/api/dining/foods/2577937?date=${bad}`)
      assert.equal(res.status, 400, bad)
      assert.equal((await res.json()).error.code, 'dining_bad_date')
    }
    assert.equal(foodCalls.length, 0, 'a rejected request never reaches the lookup')

    const missing = await fetch(`${base}/api/dining/foods/1`)
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await missing.json(), { error: { message: 'That dish is not on the menu that day.', status: 404, code: 'dining_food_not_found' } })
  })
  const food = async () => {
    throw new Error('Nutrislice down')
  }
  await withPublicApp({ food }, async ({ base }) => {
    const res = await fetch(`${base}/api/dining/foods/2577937`)
    assert.equal(res.status, 500)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal((await res.json()).error.code, 'dining_internal')
  })
})

// ── GET /api/dining/upcoming (issue #469) ───────────────────────────────────

test('what is coming up is served through both public-read limiters and cached at the edge for half an hour', async () => {
  const days = [{ date: '2026-10-15', tentative: false, holiday: null, meals: [{ meal: 'lunch', location: 'Tower Dining', headliners: [{ name: 'Chili Lime Chicken', image: null }], specials: [] }] }]
  await withPublicApp({ upcoming: async () => ({ ok: true, today: '2026-10-14', days }) }, async ({ base, limiterHits }) => {
    const res = await fetch(`${base}/api/dining/upcoming`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, today: '2026-10-14', days })
    assert.equal(res.headers.get('cache-control'), 'public, max-age=600, s-maxage=1800')
    assert.equal(res.headers.get('set-cookie'), null)
    assert.deepEqual(limiterHits, ['public-read-ip GET /api/dining/upcoming', 'public-read GET /api/dining/upcoming'])
  })
})

test('an unavailable look-ahead is never cached, and a failure answers the envelope', async () => {
  await withPublicApp({ upcoming: async () => ({ ok: false, error: 'dining_upcoming_unavailable', today: '2026-10-14', days: [] }) }, async ({ base }) => {
    const res = await fetch(`${base}/api/dining/upcoming`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })
  const upcoming = async () => {
    throw new Error('Nutrislice down')
  }
  await withPublicApp({ upcoming }, async ({ base }) => {
    const res = await fetch(`${base}/api/dining/upcoming`)
    assert.equal(res.status, 500)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal((await res.json()).error.code, 'dining_internal')
  })
})

// ── GET /api/dining/today (issue #549) ──────────────────────────────────────
// The answer itself is tested in test/diningToday.test.mjs; here, the route.

const TOWER_DAY = {
  ok: true,
  date: '2026-10-14',
  locations: [
    {
      slug: 'tower-dining',
      name: 'Tower Dining',
      kind: 'dining-hall',
      is_open: true,
      weekly_hours: { Wednesday: '7:00 AM - 9:00 PM' },
      menus: [{ meal: 'lunch', stations: [{ name: 'Homestyle', everyday: false, items: [{ name: 'Chicken Fried Steak' }] }] }],
    },
    { slug: 'campus-center', name: 'Campus Center', kind: 'retail', is_open: false, weekly_hours: {}, menus: [] },
  ],
}

test('one hall\'s day is served through both public-read limiters and cached like the snapshot', async () => {
  await withPublicApp({ snapshot: async () => TOWER_DAY }, async ({ base, limiterHits, snapshotCalls }) => {
    const res = await fetch(`${base}/api/dining/today?hall=tower`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=120, s-maxage=300')
    assert.equal(res.headers.get('set-cookie'), null)
    const body = await res.json()
    assert.equal(body.date, '2026-10-14')
    assert.deepEqual(body.hall, { slug: 'tower-dining', name: 'Tower Dining', kind: 'dining-hall' })
    assert.equal(body.open, true)
    assert.equal(body.closesAt, '2026-10-15T01:00:00Z')
    assert.deepEqual(body.meals, [
      { meal: 'lunch', from: '2026-10-14T11:00:00Z', until: '2026-10-15T01:00:00Z', headliners: [{ station: 'Homestyle', dish: 'Chicken Fried Steak' }] },
    ])
    assert.deepEqual(snapshotCalls[0], {})
    assert.deepEqual(limiterHits, ['public-read-ip GET /api/dining/today', 'public-read GET /api/dining/today'])
  })
})

test('a missing or bad hall is a 400, an unknown one a 404, no snapshot a 503 and a failure a 500, never cached', async (t) => {
  await withPublicApp({ snapshot: async () => TOWER_DAY }, async ({ base, snapshotCalls }) => {
    for (const query of ['', '?hall=', '?hall=tower%20dining', '?hall=a&hall=b']) {
      const res = await fetch(`${base}/api/dining/today${query}`)
      assert.equal(res.status, 400, query)
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await res.json(), { error: { message: 'Pick a dining hall.', status: 400, code: 'dining_bad_hall' } })
    }
    assert.equal(snapshotCalls.length, 0, 'a rejected hall never reaches the snapshot')
    const unknown = await fetch(`${base}/api/dining/today?hall=wright-quad`)
    assert.equal(unknown.status, 404)
    assert.equal(unknown.headers.get('cache-control'), 'no-store')
    assert.equal((await unknown.json()).error.code, 'dining_hall_not_found')
  })
  await withPublicApp({ snapshot: async () => ({ ok: false, error: 'schools_fetch_failed', locations: [] }) }, async ({ base }) => {
    const res = await fetch(`${base}/api/dining/today?hall=tower-dining`)
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal((await res.json()).error.code, 'dining_unavailable')
  })
  t.mock.method(console, 'error', () => {})
  const snapshot = async () => {
    throw new Error('Nutrislice down')
  }
  await withPublicApp({ snapshot }, async ({ base }) => {
    const res = await fetch(`${base}/api/dining/today?hall=tower-dining`)
    assert.equal(res.status, 500)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal((await res.json()).error.code, 'dining_internal')
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
