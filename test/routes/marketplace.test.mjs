import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createMarketplaceRouter } from '../../src/routes/marketplace.mjs'
import { BOARD_PROFANITY_USER_MESSAGE } from '../../src/boardProfanity.mjs'
import { mapListingRow } from '../../src/marketplace.mjs'
import { PhotoError } from '../../src/marketplacePhotos.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the marketplace routes as a feature router, booted on a small
// app with a fake session, recording limiters, a recording database and a
// fake of the photo helper server.mjs builds and injects.

const LINKED_AT = '2026-09-01T00:00:00.000Z'
const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com', purdue_linked_at: LINKED_AT }
const SELLER = '22222222-2222-4222-8222-222222222222'
const ADMIN = { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.com', is_admin: true, purdue_linked_at: LINKED_AT }
const LISTING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LISTING_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function listingRow(overrides = {}) {
  return {
    id: LISTING,
    user_id: STUDENT.id,
    title: 'Calculus textbook',
    description: 'Lightly used',
    category: 'textbooks',
    price_cents: 2500,
    price_mode: 'fixed',
    image_url: null,
    image_urls: [],
    status: 'active',
    hidden: false,
    created_at: '2026-09-20T15:00:00.000Z',
    ...overrides,
  }
}

const isUserAdmin = (user) => user?.is_admin === true

function fakePhotos() {
  const calls = []
  return {
    calls,
    async authorize(user, input) {
      calls.push(['authorize', user.id, input])
      return { path: `managed/${user.id}/photo.jpg`, receipt: 'receipt-1' }
    },
    async resolve(body, userId, ...rest) {
      calls.push(['resolve', userId, ...rest])
      if (body.failPhoto) throw new PhotoError('Select the photo again.', 400)
      return body.imageUploadReceipt ? { image_url: 'https://cdn.example/photo.jpg', image_urls: ['https://cdn.example/photo.jpg'] } : {}
    },
  }
}

async function withApp({ user = STUDENT, handlers = {} } = {}, run) {
  const supabase = fakeSupabase({
    marketplace_listings: () => ({ data: [], error: null }),
    marketplace_reports: () => ({ data: [], error: null }),
    users: () => ({ data: { display_name: 'Sam Seller', email: 'seller@purdue.edu' }, error: null }),
    ...handlers,
  })
  const photos = fakePhotos()
  const limiterHits = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(
    createMarketplaceRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      isUserAdmin,
      marketplacePhotos: photos,
      marketplacePhotoRateLimit: limiter('marketplacePhotoRateLimit'),
      marketplaceReadRateLimit: limiter('marketplaceReadRateLimit'),
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
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers }
  }
  try {
    await run({ call, supabase, limiterHits, photos })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const NEW_LISTING = { title: 'Calculus textbook', description: 'Lightly used', category: 'textbooks', priceCents: 2500 }

const ROUTES = [
  ['POST', '/api/marketplace/photos/authorize'],
  ['GET', '/api/marketplace'],
  ['GET', '/api/marketplace/mine'],
  ['GET', '/api/marketplace/capabilities'],
  ['GET', `/api/marketplace/${LISTING}`],
  ['POST', '/api/marketplace'],
  ['PATCH', `/api/marketplace/${LISTING}`],
  ['DELETE', `/api/marketplace/${LISTING}`],
  ['POST', `/api/marketplace/${LISTING}/report`],
]

test('every route sits behind requireAuth', async () => {
  await withApp({ user: null }, async ({ call, supabase, photos }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : { ...NEW_LISTING, reason: 'spam' })
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.equal(photos.calls.length, 0)
  })
})

test('each limited route passes its limiter under the server.mjs name', async () => {
  const handlers = {
    marketplace_listings: (chain) => {
      const op = operation(chain)
      if (op === 'insert') return { data: listingRow(), error: null }
      if (op === 'update') return { data: [listingRow()], error: null }
      if (hasCall(chain, 'maybeSingle')) return { data: listingRow({ user_id: SELLER }), error: null }
      return { data: [], error: null }
    },
    marketplace_reports: (chain) => (hasCall(chain, 'select', 'reporter_id', { count: 'exact', head: true }) ? { count: 1, error: null } : { data: null, error: null }),
  }
  await withApp({ handlers }, async ({ call, limiterHits }) => {
    for (const [method, path] of ROUTES) {
      const body = method === 'GET' || method === 'DELETE' ? undefined : path.endsWith('/report') ? { reason: 'spam' } : path.endsWith('/authorize') ? {} : NEW_LISTING
      const answer = await call(method, path, body)
      assert.ok(answer.status < 300, `${method} ${path} answered ${answer.status}`)
    }
    assert.deepEqual(limiterHits, [
      'marketplacePhotoRateLimit POST /api/marketplace/photos/authorize',
      `marketplaceReadRateLimit GET /api/marketplace/${LISTING}`,
      'boardWriteRateLimit POST /api/marketplace',
      `boardWriteRateLimit PATCH /api/marketplace/${LISTING}`,
      `userWriteRateLimit DELETE /api/marketplace/${LISTING}`,
      `boardWriteRateLimit POST /api/marketplace/${LISTING}/report`,
    ])
  })
})

test('photo authorize reaches the injected photos instance through photoAuthorizationHandler', async () => {
  let owned = listingRow()
  const handlers = { marketplace_listings: () => ({ data: owned, error: null }) }
  await withApp({ handlers }, async ({ call, supabase, photos }) => {
    const input = { listingId: LISTING, contentType: 'image/jpeg', byteSize: 1000 }
    const answer = await call('POST', '/api/marketplace/photos/authorize', input)
    assert.equal(answer.status, 201)
    assert.deepEqual(answer.body, { upload: { path: `managed/${STUDENT.id}/photo.jpg`, receipt: 'receipt-1' } })
    assert.equal(answer.headers.get('cache-control'), 'no-store')
    assert.deepEqual(photos.calls, [['authorize', STUDENT.id, input]])
    const [{ chain }] = supabase.queriesOf('marketplace_listings')
    assert.ok(hasCall(chain, 'eq', 'id', LISTING))
    assert.ok(hasCall(chain, 'eq', 'user_id', STUDENT.id), 'the listing must be the caller\'s')

    owned = null
    const refused = await call('POST', '/api/marketplace/photos/authorize', input)
    assert.equal(refused.status, 404)
    assert.deepEqual(refused.body, { error: { message: 'Listing not found or not yours.', status: 404 } })
    assert.equal(photos.calls.length, 1, 'no upload is authorized for someone else\'s listing')
  })
})

test('the list shows live, visible listings a page at a time and passes the sanitized q', async () => {
  const rows = Array.from({ length: 24 }, (_, i) => listingRow({ id: `row-${i}`, user_id: SELLER }))
  await withApp({ handlers: { marketplace_listings: () => ({ data: rows, error: null }) } }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/marketplace?page=2&category=%20Textbooks%20&q=' + encodeURIComponent('calc%,(x)'))
    assert.equal(answer.status, 200)
    assert.equal(answer.body.page, 2)
    assert.equal(answer.body.hasMore, true)
    assert.equal(answer.body.canPost, true)
    assert.equal(answer.body.listings.length, 24)
    // The public list never carries a report count, and hidden listings are filtered out.
    assert.ok(answer.body.listings.every((l) => l.hidden === false && !('reportCount' in l)))
    const [{ chain }] = supabase.queriesOf('marketplace_listings')
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'eq', 'status', 'active'))
    assert.ok(hasCall(chain, 'eq', 'hidden', false))
    assert.ok(hasCall(chain, 'order', 'created_at', { ascending: false }))
    assert.ok(hasCall(chain, 'range', 48, 71))
    assert.ok(hasCall(chain, 'eq', 'category', 'textbooks'))
    assert.ok(hasCall(chain, 'ilike', 'title', '%calc   x%'))
  })
  await withApp({ user: { ...STUDENT, purdue_linked_at: null } }, async ({ call }) => {
    const answer = await call('GET', '/api/marketplace')
    assert.deepEqual(answer.body, { listings: [], page: 0, hasMore: false, canPost: false })
  })
})

test('/mine carries hidden and reportCount for the owner\'s hidden listings only (#204)', async () => {
  const rows = [listingRow({ hidden: true }), listingRow({ id: LISTING_2 })]
  const handlers = {
    marketplace_listings: () => ({ data: rows, error: null }),
    marketplace_reports: () => ({ data: [{ listing_id: LISTING, reason: 'spam' }, { listing_id: LISTING, reason: 'scam' }, { listing_id: LISTING, reason: 'spam' }], error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/marketplace/mine')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.listings, [
      mapListingRow(rows[0], STUDENT.id, null, { reportCount: 3 }),
      mapListingRow(rows[1], STUDENT.id, null, { reportCount: undefined }),
    ])
    assert.equal(answer.body.listings[0].hidden, true)
    assert.equal(answer.body.listings[0].reportCount, 3)
    assert.ok(!('reportCount' in answer.body.listings[1]), 'a live listing\'s running total stays server-side')
    const [mine] = supabase.queriesOf('marketplace_listings')
    assert.ok(hasCall(mine.chain, 'eq', 'user_id', STUDENT.id))
    const [reports] = supabase.queriesOf('marketplace_reports')
    assert.ok(hasCall(reports.chain, 'in', 'listing_id', [LISTING]), 'only hidden listings are counted')
  })
  await withApp({ handlers: { marketplace_listings: () => ({ data: [listingRow()], error: null }) } }, async ({ call, supabase }) => {
    await call('GET', '/api/marketplace/mine')
    assert.equal(supabase.queriesOf('marketplace_reports').length, 0, 'no count query without a hidden listing')
  })
})

test('/capabilities probes the gallery and pricing columns without caching', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/marketplace/capabilities')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { gallery: true, pricing: true, maxPhotos: 6 })
    assert.equal(answer.headers.get('cache-control'), 'no-store')
    assert.ok(hasCall(supabase.queries[0].chain, 'select', 'image_urls,price_mode'))
  })
  const missing = { marketplace_listings: () => ({ data: null, error: { code: '42703', message: 'column marketplace_listings.image_urls does not exist' } }) }
  await withApp({ handlers: missing }, async ({ call }) => {
    const answer = await call('GET', '/api/marketplace/capabilities')
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, { error: { message: 'Marketplace photo and pricing setup is not complete. Please try again later.', status: 503 } })
  })
})

test('the detail hides a hidden listing from everyone but its owner and admins, and adds the seller contact', async () => {
  let row = listingRow({ user_id: SELLER, hidden: true })
  const handlers = { marketplace_listings: () => ({ data: row, error: null }) }
  await withApp({ handlers }, async ({ call }) => {
    const answer = await call('GET', `/api/marketplace/${LISTING}`)
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, { error: { message: 'Listing not found.', status: 404 } })
  })
  await withApp({ user: ADMIN, handlers }, async ({ call }) => {
    const answer = await call('GET', `/api/marketplace/${LISTING}`)
    assert.equal(answer.status, 200)
  })
  row = listingRow({ user_id: SELLER })
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', `/api/marketplace/${LISTING}`)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { listing: mapListingRow(row, STUDENT.id, { name: 'Sam Seller', email: 'seller@purdue.edu' }) })
    const [seller] = supabase.queriesOf('users')
    assert.ok(hasCall(seller.chain, 'eq', 'id', SELLER))
  })
})

test('create needs a linked Purdue account, validates, checks the text and merges the resolved photos', async () => {
  await withApp({ user: { ...STUDENT, purdue_linked_at: null } }, async ({ call, supabase }) => {
    const answer = await call('POST', '/api/marketplace', NEW_LISTING)
    assert.equal(answer.status, 403)
    assert.deepEqual(answer.body, { error: { message: 'Link your Purdue account in setup before posting.', status: 403 } })
    assert.equal(supabase.queries.length, 0)
  })
  const handlers = { marketplace_listings: () => ({ data: listingRow(), error: null }) }
  await withApp({ handlers }, async ({ call, supabase, photos }) => {
    const invalid = await call('POST', '/api/marketplace', { ...NEW_LISTING, category: 'cars' })
    assert.equal(invalid.status, 400)
    assert.match(invalid.body.error.message, /^Category must be one of: textbooks/)
    const profane = await call('POST', '/api/marketplace', { ...NEW_LISTING, description: 'mint, no cock-ups' })
    assert.deepEqual(profane.body, { error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const created = await call('POST', '/api/marketplace', { ...NEW_LISTING, imageUploadReceipt: 'receipt-1' })
    assert.equal(created.status, 201)
    assert.deepEqual(created.body, { listing: mapListingRow(listingRow(), STUDENT.id) })
    assert.deepEqual(photos.calls, [['resolve', STUDENT.id]])
    const [{ chain }] = supabase.queriesOf('marketplace_listings')
    const insert = chain.find((c) => c.method === 'insert').args[0]
    assert.equal(insert.user_id, STUDENT.id)
    assert.equal(insert.image_url, 'https://cdn.example/photo.jpg')
    assert.equal(insert.price_cents, 2500)
  })
})

test('edit is owner only: 404 for a listing that is not the caller\'s, the scoped update otherwise', async () => {
  let owned = null
  const handlers = {
    marketplace_listings: (chain) => (operation(chain) === 'update' ? { data: [listingRow({ status: 'sold' })], error: null } : { data: owned, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const nothing = await call('PATCH', `/api/marketplace/${LISTING}`, { unknown: true })
    assert.equal(nothing.status, 400)
    assert.deepEqual(nothing.body, { error: { message: 'No valid fields to update.', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const notMine = await call('PATCH', `/api/marketplace/${LISTING}`, { status: 'sold' })
    assert.equal(notMine.status, 404)
    assert.deepEqual(notMine.body, { error: { message: 'Listing not found or not yours.', status: 404 } })
    const [lookup] = supabase.queriesOf('marketplace_listings')
    assert.ok(hasCall(lookup.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(hasCall(lookup.chain, 'is', 'deleted_at', null))

    owned = listingRow({ image_url: 'https://cdn.example/old.jpg', image_urls: ['https://cdn.example/old.jpg'] })
    const sold = await call('PATCH', `/api/marketplace/${LISTING}`, { status: 'sold' })
    assert.equal(sold.status, 200)
    assert.equal(sold.body.listing.status, 'sold')
    const update = supabase.queriesOf('marketplace_listings').find((q) => operation(q.chain) === 'update').chain
    const values = update.find((c) => c.method === 'update').args[0]
    assert.equal(values.status, 'sold')
    assert.ok(!Number.isNaN(Date.parse(values.updated_at)))
    assert.ok(hasCall(update, 'eq', 'id', LISTING))
    assert.ok(hasCall(update, 'eq', 'user_id', STUDENT.id))
  })
})

test('delete runs through ownerOrAdminScope with 204, and 404 when nothing matched', async () => {
  let rows = [{ id: LISTING }]
  const handlers = { marketplace_listings: () => ({ data: rows, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    assert.equal((await call('DELETE', `/api/marketplace/${LISTING}`)).status, 204)
    const [{ chain }] = supabase.queriesOf('marketplace_listings')
    assert.deepEqual(Object.keys(chain.find((c) => c.method === 'update').args[0]), ['deleted_at'])
    assert.ok(hasCall(chain, 'eq', 'user_id', STUDENT.id))
    rows = []
    const missing = await call('DELETE', `/api/marketplace/${LISTING}`)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Listing not found or not yours.', status: 404 } })
  })
  rows = [{ id: LISTING }]
  await withApp({ user: ADMIN, handlers }, async ({ call, supabase }) => {
    assert.equal((await call('DELETE', `/api/marketplace/${LISTING}`)).status, 204)
    assert.ok(!hasCall(supabase.queriesOf('marketplace_listings')[0].chain, 'eq', 'user_id'), 'an admin takedown has no owner filter')
  })
})

test('report: a bad reason is a 400, a self-report and a missing listing are refused before the insert', async () => {
  let listing = listingRow()
  const handlers = { marketplace_listings: () => ({ data: listing, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const noReason = await call('POST', `/api/marketplace/${LISTING}/report`, {})
    assert.equal(noReason.status, 400)
    assert.deepEqual(noReason.body, { error: { message: 'Choose a reason for the report.', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const self = await call('POST', `/api/marketplace/${LISTING}/report`, { reason: 'spam' })
    assert.equal(self.status, 400)
    assert.deepEqual(self.body, { error: { message: 'You cannot report your own listing.', status: 400 } })

    listing = null
    const missing = await call('POST', `/api/marketplace/${LISTING}/report`, { reason: 'spam' })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Listing not found.', status: 404 } })
    assert.equal(supabase.queriesOf('marketplace_reports').length, 0)
  })
})

test('report: a duplicate answers without recounting, and the third distinct reporter hides the listing', async () => {
  let reporters = 0
  let duplicate = false
  const handlers = {
    marketplace_listings: (chain) => (operation(chain) === 'update' ? { data: null, error: null } : { data: listingRow({ user_id: SELLER }), error: null }),
    marketplace_reports: (chain) => {
      if (operation(chain) === 'insert') {
        if (duplicate) return { data: null, error: { code: '23505', message: 'duplicate key value' } }
        reporters += 1
        return { data: null, error: null }
      }
      return { count: reporters, error: null }
    },
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    assert.deepEqual((await call('POST', `/api/marketplace/${LISTING}/report`, { reason: 'other: never shipped' })).body, { ok: true })
    const insert = supabase.queriesOf('marketplace_reports')[0].chain.find((c) => c.method === 'insert').args[0]
    assert.equal(insert.listing_id, LISTING)
    assert.equal(insert.reporter_id, STUDENT.id)
    assert.equal(insert.reason, 'other: never shipped')
    assert.deepEqual((await call('POST', `/api/marketplace/${LISTING}/report`, { reason: 'spam' })).body, { ok: true })
    assert.equal(supabase.queriesOf('marketplace_listings').filter((q) => operation(q.chain) === 'update').length, 0, 'two reporters do not hide it')

    duplicate = true
    const before = supabase.queriesOf('marketplace_reports').length
    assert.deepEqual((await call('POST', `/api/marketplace/${LISTING}/report`, { reason: 'spam' })).body, { ok: true, duplicate: true })
    assert.equal(supabase.queriesOf('marketplace_reports').length, before + 1, 'the duplicate insert is the only query, no recount')

    duplicate = false
    assert.deepEqual((await call('POST', `/api/marketplace/${LISTING}/report`, { reason: 'scam' })).body, { ok: true })
    const hide = supabase.queriesOf('marketplace_listings').find((q) => operation(q.chain) === 'update')
    assert.ok(hasCall(hide.chain, 'update', { hidden: true }))
    assert.ok(hasCall(hide.chain, 'eq', 'id', LISTING))
  })
})

test('database failures: marketplace_schema_missing for a missing table, a PhotoError keeps its status, 500 otherwise', async (t) => {
  t.mock.method(console, 'error', () => {})
  const noTable = { marketplace_listings: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.marketplace_listings' in the schema cache" } }) }
  await withApp({ handlers: noTable }, async ({ call }) => {
    const answer = await call('GET', '/api/marketplace')
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, { error: { message: 'The marketplace is not set up yet. Please try again later.', code: 'marketplace_schema_missing', status: 503 } })
  })
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('POST', '/api/marketplace', { ...NEW_LISTING, failPhoto: true })
    assert.equal(answer.status, 400)
    assert.deepEqual(answer.body, { error: { message: 'Select the photo again.', status: 400 } })
    assert.equal(supabase.queries.length, 0)
  })
  const broken = { marketplace_listings: () => ({ data: null, error: { code: '23514', message: 'check constraint' } }) }
  await withApp({ handlers: broken }, async ({ call }) => {
    const answer = await call('GET', '/api/marketplace/mine')
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not load the marketplace. Please try again.', status: 500 } })
  })
})

test('a malformed :id answers the 404 envelope before any query', async () => {
  await withApp({}, async ({ call, supabase }) => {
    for (const [method, path] of [
      ['GET', '/api/marketplace/not-a-uuid'],
      ['PATCH', '/api/marketplace/not-a-uuid'],
      ['DELETE', '/api/marketplace/not-a-uuid'],
      ['POST', '/api/marketplace/not-a-uuid/report'],
    ]) {
      const answer = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : { status: 'sold', reason: 'spam' })
      assert.equal(answer.status, 404, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'Not found.', status: 404 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})
