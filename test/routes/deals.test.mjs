import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createDealsRouter } from '../../src/routes/deals.mjs'
import { mapDealRow } from '../../src/campusDeals.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the Campus Perks routes as a feature router, booted on a small
// app with a fake session, a recording limiter and a recording database.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com' }
const ADMIN = { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.com', is_admin: true }
const DEAL_ID = '55555555-5555-4555-8555-555555555555'

function dealRow(overrides = {}) {
  return {
    id: DEAL_ID,
    business_name: 'Bean There',
    description: '10% off any drink',
    category: 'coffee',
    image_url: null,
    address: null,
    lat: null,
    lng: null,
    expires_at: null,
    featured: false,
    active: true,
    created_at: '2026-09-01T12:00:00.000Z',
    ...overrides,
  }
}

const isUserAdmin = (user) => user?.is_admin === true

async function withApp({ user = STUDENT, table = () => ({ data: [], error: null }) } = {}, run) {
  const supabase = fakeSupabase({ deals: table })
  const limiterHits = []
  const app = express()
  app.use(express.json())
  app.use(
    createDealsRouter({
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
      userWriteRateLimit: (req, _res, next) => {
        limiterHits.push(`${req.method} ${req.path}`)
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
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  try {
    await run({ call, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const NEW_DEAL = { businessName: 'Bean There', description: '10% off any drink', category: 'coffee' }

test('every route sits behind requireAuth', async () => {
  await withApp({ user: null }, async ({ call, supabase }) => {
    for (const [method, path] of [
      ['GET', '/api/deals'],
      ['POST', '/api/deals'],
      ['PATCH', `/api/deals/${DEAL_ID}`],
      ['DELETE', `/api/deals/${DEAL_ID}`],
    ]) {
      const answer = await call(method, path, method === 'POST' || method === 'PATCH' ? NEW_DEAL : undefined)
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('a student sees only active, unexpired deals, with isAdmin false, even when asking for all', async () => {
  const rows = [
    dealRow(),
    dealRow({ id: 'inactive', active: false }),
    dealRow({ id: 'expired', expires_at: '2020-01-01T00:00:00.000Z' }),
    dealRow({ id: 'later', expires_at: '2999-01-01T00:00:00.000Z' }),
  ]
  await withApp({ table: () => ({ data: rows, error: null }) }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/deals?all=1&category=%20Coffee%20')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.isAdmin, false)
    assert.deepEqual(answer.body.deals.map((d) => d.id), [DEAL_ID, 'later'])
    assert.deepEqual(answer.body.deals[0], mapDealRow(dealRow()))
    const [{ chain }] = supabase.queriesOf('deals')
    assert.ok(hasCall(chain, 'select', '*'))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.deepEqual(chain.filter((c) => c.method === 'order').map((c) => c.args), [
      ['featured', { ascending: false }],
      ['created_at', { ascending: false }],
    ])
    assert.ok(hasCall(chain, 'limit', 200))
    assert.ok(hasCall(chain, 'eq', 'category', 'coffee'), 'the category is trimmed and lowercased')
  })
})

test('an admin asking for all gets inactive and expired deals too, with isAdmin true', async () => {
  const rows = [dealRow(), dealRow({ id: 'inactive', active: false }), dealRow({ id: 'expired', expires_at: '2020-01-01T00:00:00.000Z' })]
  await withApp({ user: ADMIN, table: () => ({ data: rows, error: null }) }, async ({ call, supabase }) => {
    const all = await call('GET', '/api/deals?all=1')
    assert.equal(all.body.isAdmin, true)
    assert.deepEqual(all.body.deals.map((d) => d.id), [DEAL_ID, 'inactive', 'expired'])
    assert.ok(!hasCall(supabase.queries[0].chain, 'eq'), 'no category filter without ?category')

    const plain = await call('GET', '/api/deals')
    assert.equal(plain.body.isAdmin, true)
    assert.deepEqual(plain.body.deals.map((d) => d.id), [DEAL_ID], 'without ?all=1 an admin sees the student list')
  })
})

test('the three writes pass the write limiter and answer 403 for a student before any query', async () => {
  await withApp({}, async ({ call, supabase, limiterHits }) => {
    for (const [method, path] of [
      ['POST', '/api/deals'],
      ['PATCH', `/api/deals/${DEAL_ID}`],
      ['DELETE', `/api/deals/${DEAL_ID}`],
    ]) {
      const answer = await call(method, path, method === 'DELETE' ? undefined : NEW_DEAL)
      assert.equal(answer.status, 403, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'Admin access required.', status: 403 } })
    }
    assert.deepEqual(limiterHits, ['POST /api/deals', `PATCH /api/deals/${DEAL_ID}`, `DELETE /api/deals/${DEAL_ID}`])
    assert.equal(supabase.queries.length, 0)
    const read = await call('GET', '/api/deals')
    assert.equal(read.status, 200)
    assert.equal(limiterHits.length, 3, 'the list is not write-limited')
  })
})

test('POST validates with validateDealInput, then inserts for the admin and answers 201', async () => {
  await withApp({ user: ADMIN, table: () => ({ data: dealRow(), error: null }) }, async ({ call, supabase }) => {
    const invalid = await call('POST', '/api/deals', { description: 'no name', category: 'coffee' })
    assert.equal(invalid.status, 400)
    assert.deepEqual(invalid.body, { error: { message: 'Business name is required (max 120 characters)', status: 400 } })
    const badCategory = await call('POST', '/api/deals', { businessName: 'X', category: 'cars' })
    assert.equal(badCategory.status, 400)
    assert.match(badCategory.body.error.message, /^Category must be one of: /)
    assert.equal(supabase.queries.length, 0)

    const created = await call('POST', '/api/deals', NEW_DEAL)
    assert.equal(created.status, 201)
    assert.deepEqual(created.body, { deal: mapDealRow(dealRow()) })
    const [{ chain }] = supabase.queriesOf('deals')
    assert.ok(hasCall(chain, 'insert', { business_name: 'Bean There', description: '10% off any drink', category: 'coffee', created_by: ADMIN.id }))
    assert.ok(hasCall(chain, 'select', '*'))
    assert.ok(hasCall(chain, 'single'))
  })
})

test('PATCH needs a valid field, updates the live row and answers 404 when none matched', async () => {
  let found = dealRow({ featured: true })
  await withApp({ user: ADMIN, table: () => ({ data: found, error: null }) }, async ({ call, supabase }) => {
    const empty = await call('PATCH', `/api/deals/${DEAL_ID}`, { unknown: 1 })
    assert.equal(empty.status, 400)
    assert.deepEqual(empty.body, { error: { message: 'No valid fields to update.', status: 400 } })
    const invalid = await call('PATCH', `/api/deals/${DEAL_ID}`, { expiresAt: 'not a date' })
    assert.deepEqual(invalid.body, { error: { message: 'Expiry date is invalid', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const updated = await call('PATCH', `/api/deals/${DEAL_ID}`, { featured: true })
    assert.equal(updated.status, 200)
    assert.deepEqual(updated.body, { deal: mapDealRow(found) })
    const [{ chain }] = supabase.queriesOf('deals')
    assert.equal(operation(chain), 'update')
    assert.ok(hasCall(chain, 'update', { featured: true }))
    assert.ok(hasCall(chain, 'eq', 'id', DEAL_ID))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'maybeSingle'))

    found = null
    const missing = await call('PATCH', `/api/deals/${DEAL_ID}`, { featured: false })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Deal not found.', status: 404 } })
  })
})

test('DELETE soft-deletes the live row with 204 and answers 404 when nothing matched', async () => {
  let rows = [{ id: DEAL_ID }]
  await withApp({ user: ADMIN, table: () => ({ data: rows, error: null }) }, async ({ call, supabase }) => {
    const answer = await call('DELETE', `/api/deals/${DEAL_ID}`)
    assert.equal(answer.status, 204)
    assert.equal(answer.body, null)
    const [{ chain }] = supabase.queriesOf('deals')
    const values = chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(values), ['deleted_at'])
    assert.ok(!Number.isNaN(Date.parse(values.deleted_at)))
    assert.ok(hasCall(chain, 'eq', 'id', DEAL_ID))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'select', 'id'))

    rows = []
    const missing = await call('DELETE', `/api/deals/${DEAL_ID}`)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Deal not found.', status: 404 } })
  })
})

test('database failures answer the deals envelope: 503 deals_schema_missing for a missing table or deleted_at, 500 otherwise', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const schemaMissing = { error: { message: 'Campus Perks is not set up yet. Please try again later.', code: 'deals_schema_missing', status: 503 } }

  await withApp({ table: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.deals' in the schema cache" } }) }, async ({ call }) => {
    const answer = await call('GET', '/api/deals')
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, schemaMissing)
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-campus-deals\.sql/)

  await withApp({ user: ADMIN, table: () => ({ data: null, error: { code: '42703', message: 'column deals.deleted_at does not exist' } }) }, async ({ call }) => {
    const answer = await call('DELETE', `/api/deals/${DEAL_ID}`)
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, schemaMissing)
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-soft-delete\.sql/, 'the log names the soft-delete migration')

  await withApp({ user: ADMIN, table: () => ({ data: null, error: { code: '23514', message: 'new row violates check constraint' } }) }, async ({ call }) => {
    const answer = await call('POST', '/api/deals', NEW_DEAL)
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not load deals. Please try again.', status: 500 } })
  })
})

test('a malformed :id answers the 404 envelope before auth or any query', async () => {
  await withApp({ user: null }, async ({ call, supabase, limiterHits }) => {
    for (const method of ['PATCH', 'DELETE']) {
      const answer = await call(method, '/api/deals/not-a-uuid', method === 'PATCH' ? { featured: true } : undefined)
      assert.equal(answer.status, 404, method)
      assert.deepEqual(answer.body, { error: { message: 'Not found.', status: 404 } })
    }
    assert.equal(limiterHits.length, 2, 'the limiter still counts the attempt')
    assert.equal(supabase.queries.length, 0)
  })
})
