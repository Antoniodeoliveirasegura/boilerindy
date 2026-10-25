import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createAdminPhotoReviewRouter } from '../../src/routes/adminPhotoReview.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #504: the admin photo queue, booted on a small app with a fake
// session, a fake admin gate, a recording limiter and a recording database.
// Listings whose photos wait for an admin are listed oldest first; approve
// shows the photos to everyone, reject clears them from the listing.

const ADMIN = { id: '99999999-9999-4999-8999-999999999999', email: 'admin@purdue.edu', is_admin: true }
const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@purdue.edu' }
const SELLER = '22222222-2222-4222-8222-222222222222'
const LISTING = '55555555-5555-4555-8555-555555555555'
const LISTING_2 = '56565656-5656-4565-8565-565656565656'
const UPDATED_AT = '2026-10-24T15:04:05.123456+00:00'
const PHOTO = 'https://cdn.example/managed/photo.jpg'

function pendingRow(overrides = {}) {
  return {
    id: LISTING,
    user_id: SELLER,
    title: 'Mini fridge',
    description: 'Works, a little loud',
    category: 'furniture',
    price_cents: 4000,
    status: 'active',
    hidden: false,
    image_url: PHOTO,
    image_urls: [PHOTO],
    photos_review: 'pending',
    created_at: '2026-10-24T12:00:00+00:00',
    updated_at: UPDATED_AT,
    deleted_at: null,
    ...overrides,
  }
}

async function withApp({ user = ADMIN, handlers = {} } = {}, run) {
  const supabase = fakeSupabase({
    marketplace_listings: () => ({ data: [], error: null }),
    users: () => ({ data: [{ id: SELLER, display_name: 'Blake' }], error: null }),
    ...handlers,
  })
  const limiterHits = []
  const app = express()
  app.use(express.json())
  app.use(
    createAdminPhotoReviewRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      // Same gate as server.mjs requireAdmin.
      requireAdmin: (req, res, next) => {
        if (req.currentUser?.is_admin !== true) return res.status(403).json({ error: { message: 'Admin access required.', status: 403 } })
        next()
      },
      adminWriteRateLimit: (req, _res, next) => {
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
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  try {
    await run({ call, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const WRITES = [
  ['POST', `/api/admin/photo-review/${LISTING}/approve`],
  ['POST', `/api/admin/photo-review/${LISTING}/reject`],
]

test('all three routes answer 401 signed out and 403 for a student before any query, and only the writes pass the limiter, ahead of auth', async () => {
  for (const [user, status, message] of [
    [null, 401, 'You must sign in to access this resource.'],
    [STUDENT, 403, 'Admin access required.'],
  ]) {
    await withApp({ user }, async ({ call, supabase, limiterHits }) => {
      for (const [method, path] of [['GET', '/api/admin/photo-review'], ...WRITES]) {
        const answer = await call(method, path, method === 'GET' ? undefined : { updatedAt: UPDATED_AT })
        assert.equal(answer.status, status, `${method} ${path}`)
        assert.deepEqual(answer.body, { error: { message, status } })
      }
      assert.equal(supabase.queries.length, 0)
      assert.deepEqual(limiterHits, WRITES.map(([method, path]) => `${method} ${path}`))
    })
  }
})

test('a malformed :id answers the 404 envelope before auth, after the limiter', async () => {
  for (const user of [null, ADMIN]) {
    await withApp({ user }, async ({ call, supabase, limiterHits }) => {
      for (const verb of ['approve', 'reject']) {
        const answer = await call('POST', `/api/admin/photo-review/not-a-uuid/${verb}`, { updatedAt: UPDATED_AT })
        assert.equal(answer.status, 404)
        assert.deepEqual(answer.body, { error: { message: 'Not found.', status: 404 } })
      }
      assert.equal(supabase.queries.length, 0)
      assert.equal(limiterHits.length, 2)
    })
  }
})

test('the queue lists live listings with pending photos, the longest waiting first, with the seller and the version to send back', async () => {
  const rows = [pendingRow(), pendingRow({ id: LISTING_2, title: 'Desk lamp', image_url: null, image_urls: ['https://example.com/lamp.jpg', PHOTO], hidden: true, updated_at: '2026-10-24T16:00:00+00:00' })]
  await withApp({ handlers: { marketplace_listings: () => ({ data: rows, error: null }) } }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/admin/photo-review')
    assert.equal(answer.status, 200)
    assert.equal(answer.headers.get('cache-control'), 'no-store')
    assert.deepEqual(answer.body, {
      listings: [
        {
          id: LISTING,
          title: 'Mini fridge',
          description: 'Works, a little loud',
          category: 'furniture',
          status: 'active',
          hidden: false,
          createdAt: '2026-10-24T12:00:00+00:00',
          updatedAt: UPDATED_AT,
          images: [PHOTO],
          seller: { id: SELLER, displayName: 'Blake' },
        },
        {
          id: LISTING_2,
          title: 'Desk lamp',
          description: 'Works, a little loud',
          category: 'furniture',
          status: 'active',
          hidden: true,
          createdAt: '2026-10-24T12:00:00+00:00',
          updatedAt: '2026-10-24T16:00:00+00:00',
          images: ['https://example.com/lamp.jpg', PHOTO],
          seller: { id: SELLER, displayName: 'Blake' },
        },
      ],
    })
    const [{ chain }] = supabase.queriesOf('marketplace_listings')
    assert.ok(hasCall(chain, 'select', '*'))
    assert.ok(hasCall(chain, 'eq', 'photos_review', 'pending'))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'order', 'updated_at', { ascending: true }))
    assert.ok(hasCall(chain, 'limit', 200))
    const [users] = supabase.queriesOf('users')
    assert.ok(hasCall(users.chain, 'in', 'id', [SELLER]))
  })
  await withApp({}, async ({ call, supabase }) => {
    assert.deepEqual((await call('GET', '/api/admin/photo-review')).body, { listings: [] })
    assert.equal(supabase.queriesOf('users').length, 0)
  })
})

// The update a decision ran, and its answer, for one decision on a listing.
function decisionHandlers(state) {
  return {
    marketplace_listings: (chain) => {
      if (operation(chain) === 'update') {
        const stillThatVersion = hasCall(chain, 'eq', 'updated_at', state.row?.updated_at) && state.row?.photos_review === 'pending'
        return { data: stillThatVersion ? [{ id: LISTING }] : [], error: null }
      }
      return { data: state.row ? { id: state.row.id, photos_review: state.row.photos_review } : null, error: null }
    },
  }
}

test('approve records the admin and the time, scoped to the pending version the admin saw', async () => {
  const state = { row: pendingRow() }
  await withApp({ handlers: decisionHandlers(state) }, async ({ call, supabase, limiterHits }) => {
    const before = Date.now()
    const answer = await call('POST', `/api/admin/photo-review/${LISTING}/approve`, { updatedAt: UPDATED_AT })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true, photosReview: 'approved' })
    assert.deepEqual(limiterHits, [`POST /api/admin/photo-review/${LISTING}/approve`])
    const [update] = supabase.queriesOf('marketplace_listings')
    const values = update.chain.find((c) => c.method === 'update').args[0]
    assert.deepEqual(Object.keys(values), ['photos_review', 'photos_reviewed_at', 'photos_reviewed_by'])
    assert.equal(values.photos_review, 'approved')
    assert.equal(values.photos_reviewed_by, ADMIN.id)
    assert.ok(Date.parse(values.photos_reviewed_at) >= before - 1000)
    assert.ok(hasCall(update.chain, 'eq', 'id', LISTING))
    assert.ok(hasCall(update.chain, 'eq', 'photos_review', 'pending'))
    assert.ok(hasCall(update.chain, 'eq', 'updated_at', UPDATED_AT))
    assert.ok(hasCall(update.chain, 'is', 'deleted_at', null))
  })
})

test('reject clears the listing\'s photos with the decision; the listing itself stays up', async () => {
  const state = { row: pendingRow() }
  await withApp({ handlers: decisionHandlers(state) }, async ({ call, supabase }) => {
    const answer = await call('POST', `/api/admin/photo-review/${LISTING}/reject`, { updatedAt: UPDATED_AT })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true, photosReview: 'rejected' })
    const [update] = supabase.queriesOf('marketplace_listings')
    const values = update.chain.find((c) => c.method === 'update').args[0]
    assert.equal(values.photos_review, 'rejected')
    assert.equal(values.image_url, null)
    assert.deepEqual(values.image_urls, [])
    assert.ok(!('deleted_at' in values) && !('status' in values), 'only the photos go')
  })
})

test('a decision needs the version from the queue: 400 without it, 409 after the seller edited, 404 once it left the queue', async () => {
  const state = { row: pendingRow() }
  await withApp({ handlers: decisionHandlers(state) }, async ({ call, supabase }) => {
    for (const body of [{}, { updatedAt: '' }, { updatedAt: 'yesterday-ish' }, { updatedAt: 42 }, { updatedAt: `${UPDATED_AT}${'0'.repeat(64)}` }]) {
      const answer = await call('POST', `/api/admin/photo-review/${LISTING}/approve`, body)
      assert.equal(answer.status, 400, JSON.stringify(body))
      assert.deepEqual(answer.body, { error: { message: 'Reload the photo queue and try again.', status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)

    // The seller changed the listing after the queue loaded: its updated_at moved on.
    state.row = pendingRow({ updated_at: '2026-10-24T15:30:00+00:00' })
    const stale = await call('POST', `/api/admin/photo-review/${LISTING}/approve`, { updatedAt: UPDATED_AT })
    assert.equal(stale.status, 409)
    assert.deepEqual(stale.body, { error: { message: 'The seller changed this listing after the queue loaded. Reload to see the latest photos.', status: 409 } })

    // Another admin decided first, or the listing was deleted.
    for (const row of [pendingRow({ photos_review: 'approved' }), null]) {
      state.row = row
      const gone = await call('POST', `/api/admin/photo-review/${LISTING}/reject`, { updatedAt: UPDATED_AT })
      assert.equal(gone.status, 404)
      assert.deepEqual(gone.body, { error: { message: 'No listing with photos waiting for review.', status: 404 } })
    }
  })
})

test('before README step 46 every route answers 503 photo_review_schema_missing; other failures keep the marketplace answers', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const missingColumn = { code: '42703', message: 'column marketplace_listings.photos_review does not exist' }
  await withApp({ handlers: { marketplace_listings: () => ({ data: null, error: missingColumn }) } }, async ({ call }) => {
    for (const [method, path] of [['GET', '/api/admin/photo-review'], ...WRITES]) {
      const answer = await call(method, path, method === 'GET' ? undefined : { updatedAt: UPDATED_AT })
      assert.equal(answer.status, 503, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'Photo review is not set up yet. Please try again later.', code: 'photo_review_schema_missing', status: 503 } })
    }
  })
  assert.match(String(logged.mock.calls[0].arguments[0]), /\[photo_review\] schema missing: run db\/supabase-marketplace-photo-review\.sql/)

  const noTable = { code: 'PGRST205', message: "Could not find the table 'public.marketplace_listings' in the schema cache" }
  await withApp({ handlers: { marketplace_listings: () => ({ data: null, error: noTable }) } }, async ({ call }) => {
    assert.equal((await call('GET', '/api/admin/photo-review')).body.error.code, 'marketplace_schema_missing')
  })
  const broken = { code: '57014', message: 'canceling statement due to statement timeout' }
  await withApp({ handlers: { marketplace_listings: () => ({ data: null, error: broken }) } }, async ({ call }) => {
    const answer = await call('POST', `/api/admin/photo-review/${LISTING}/approve`, { updatedAt: UPDATED_AT })
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not load the marketplace. Please try again.', status: 500 } })
  })
})
