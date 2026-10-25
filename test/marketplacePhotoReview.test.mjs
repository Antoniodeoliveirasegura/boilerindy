import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DB_FEATURES } from '../src/dbErrors.mjs'
import { mapListingRow } from '../src/marketplace.mjs'
import { respondMarketplaceDbError } from '../src/marketplaceDb.mjs'
import {
  countPendingPhotoReviews,
  decidePhotoReview,
  isMissingPhotoReviewColumn,
  listingPhotoUrls,
  listPendingPhotoReviews,
  mapPhotoReviewRow,
  nextPhotoReview,
  PHOTO_REVIEW_QUEUE_LIMIT,
  PHOTO_REVIEW_SQL_FILE,
  PHOTO_REVIEW_STATES,
  photoReviewState,
} from '../src/marketplacePhotoReview.mjs'
import { fakeSupabase, hasCall, operation } from './routes/fakeSupabase.mjs'

// Issue #504: new marketplace photos wait for an admin before other students
// see them. The state lives in marketplace_listings.photos_review (README step
// 46); these pin how a row reads, what a write stores and the queue helpers.

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ADMIN = '33333333-3333-4333-8333-333333333333'
const LISTING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const A = 'https://cdn.example/a.jpg'
const B = 'https://cdn.example/b.jpg'
const C = 'https://cdn.example/c.jpg'
const MISSING_COLUMN = { code: '42703', message: 'column marketplace_listings.photos_review does not exist' }

function row(overrides = {}) {
  return { id: LISTING, user_id: OWNER, title: 'Desk', category: 'furniture', status: 'active', image_url: A, image_urls: [A, B], photos_review: 'approved', ...overrides }
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
}

test('the states match the CHECK in the step 46 file, which README lists', () => {
  const sql = readFileSync(new URL('../db/supabase-marketplace-photo-review.sql', import.meta.url), 'utf8')
  assert.match(sql, /CHECK \(photos_review IN \('pending', 'approved', 'rejected'\)\)/)
  assert.match(sql, /photos_review TEXT NOT NULL DEFAULT 'approved'/)
  assert.deepEqual([...PHOTO_REVIEW_STATES], ['pending', 'approved', 'rejected'])
  assert.equal(PHOTO_REVIEW_SQL_FILE, 'db/supabase-marketplace-photo-review.sql')
  assert.equal(DB_FEATURES.photo_review.sqlFile, PHOTO_REVIEW_SQL_FILE)
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /^46\. .*`db\/supabase-marketplace-photo-review\.sql`/m)
})

test('photoReviewState: pending and rejected as stored, anything else (a row from before step 46) approved', () => {
  assert.equal(photoReviewState(row({ photos_review: 'pending' })), 'pending')
  assert.equal(photoReviewState(row({ photos_review: 'rejected' })), 'rejected')
  assert.equal(photoReviewState(row({ photos_review: 'approved' })), 'approved')
  assert.equal(photoReviewState({ id: LISTING }), 'approved', 'no column yet')
  assert.equal(photoReviewState(row({ photos_review: 'PENDING' })), 'approved')
  assert.equal(photoReviewState(null), 'approved')
})

test('listingPhotoUrls: the gallery, or the legacy cover alone, or nothing', () => {
  assert.deepEqual(listingPhotoUrls(row()), [A, B])
  assert.deepEqual(listingPhotoUrls({ image_url: A }), [A])
  assert.deepEqual(listingPhotoUrls({ image_url: A, image_urls: [] }), [A])
  assert.deepEqual(listingPhotoUrls({ image_url: null, image_urls: [] }), [])
  assert.deepEqual(listingPhotoUrls(null), [])
})

test('nextPhotoReview with the switch on: a new photo waits, a create without photos and a text edit do not', () => {
  const on = (current, nextUrls) => nextPhotoReview({ reviewOn: true, current, nextUrls })
  // Creates.
  assert.equal(on(null, [A]), 'pending')
  assert.equal(on(null, []), undefined)
  assert.equal(on(null, undefined), undefined)
  // Edits that add a photo, to an approved, a pending or a rejected listing.
  assert.equal(on(row(), [A, B, C]), 'pending')
  assert.equal(on(row(), [C]), 'pending', 'a replaced photo is a new one')
  // Written over pending too, so an approval racing the edit cannot approve the new photo.
  assert.equal(on(row({ photos_review: 'pending' }), [A, B, C]), 'pending')
  assert.equal(on(row({ photos_review: 'rejected', image_url: null, image_urls: [] }), [C]), 'pending')
  // A reorder or a removal adds nothing to review.
  assert.equal(on(row(), [B, A]), undefined)
  assert.equal(on(row(), [B]), undefined)
  assert.equal(on(row({ photos_review: 'pending' }), [A]), undefined, 'still pending: the kept photo was never reviewed')
  // No photos left: nothing waits.
  assert.equal(on(row({ photos_review: 'pending' }), []), 'approved')
  assert.equal(on(row({ photos_review: 'rejected', image_url: null, image_urls: [] }), []), 'approved')
  assert.equal(on(row(), []), undefined)
  // A text edit does not touch the photos.
  assert.equal(on(row({ photos_review: 'pending' }), undefined), undefined)
  // A legacy cover counts as the photo the listing had.
  assert.equal(on({ image_url: A }, [A]), undefined)
})

test('nextPhotoReview with the switch off never names the column for a listing that is approved, or has no column yet', () => {
  const off = (current, nextUrls) => nextPhotoReview({ reviewOn: false, current, nextUrls })
  assert.equal(off(null, [A]), undefined)
  assert.equal(off(row(), [A, B, C]), undefined)
  assert.equal(off({ id: LISTING, image_url: A, image_urls: [A] }, [A, C]), undefined, 'a database without step 46')
  assert.equal(off(row(), []), undefined)
  // A rejected listing had its photos cleared, so new ones are not held.
  assert.equal(off(row({ photos_review: 'rejected', image_url: null, image_urls: [] }), [C]), 'approved')
  // A pending listing stays pending: photos nobody reviewed may still be on it.
  assert.equal(off(row({ photos_review: 'pending' }), [A, B, C]), undefined)
  assert.equal(off(row({ photos_review: 'pending' }), []), 'approved')
  // Only a real true turns it on.
  assert.equal(nextPhotoReview({ reviewOn: 'on', current: null, nextUrls: [A] }), undefined)
})

test('isMissingPhotoReviewColumn matches the three columns, from a read or a write, and nothing else', () => {
  assert.equal(isMissingPhotoReviewColumn(MISSING_COLUMN), true)
  assert.equal(isMissingPhotoReviewColumn({ code: 'PGRST204', message: "Could not find the 'photos_review' column of 'marketplace_listings' in the schema cache" }), true)
  assert.equal(isMissingPhotoReviewColumn({ code: 'PGRST204', message: "Could not find the 'photos_reviewed_by' column of 'marketplace_listings' in the schema cache" }), true)
  assert.equal(isMissingPhotoReviewColumn({ code: '42703', message: 'column marketplace_listings.photos_reviewed_at does not exist' }), true)
  assert.equal(isMissingPhotoReviewColumn({ code: '42703', message: 'column marketplace_listings.image_urls does not exist' }), false)
  assert.equal(isMissingPhotoReviewColumn({ code: 'PGRST205', message: "Could not find the table 'public.marketplace_listings' in the schema cache" }), false)
  assert.equal(isMissingPhotoReviewColumn({ code: '23514', message: 'photos_review check' }), false)
  assert.equal(isMissingPhotoReviewColumn(null), false)
})

test('respondMarketplaceDbError answers a missing photo review column with photo_review_schema_missing and logs the step 46 file', (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const res = mockRes()
  respondMarketplaceDbError(res, { code: 'PGRST204', message: "Could not find the 'photos_review' column of 'marketplace_listings' in the schema cache" })
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.body, { error: { message: 'Photo review is not set up yet. Please try again later.', code: 'photo_review_schema_missing', status: 503 } })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-marketplace-photo-review\.sql in/)
  // A missing marketplace table still answers the marketplace code.
  const table = mockRes()
  respondMarketplaceDbError(table, { code: 'PGRST205', message: "Could not find the table 'public.marketplace_listings' in the schema cache" })
  assert.equal(table.body.error.code, 'marketplace_schema_missing')
})

test('mapListingRow: photos that are not approved reach only the owner and admins, and the flag reaches everyone', () => {
  for (const state of ['pending', 'rejected']) {
    const listing = row({ photos_review: state })
    const stranger = mapListingRow(listing, OTHER)
    assert.deepEqual(stranger.images, [], state)
    assert.equal(stranger.imageUrl, null, state)
    assert.equal(stranger.photosPending, state === 'pending')
    assert.ok(!('photosReview' in stranger), `${state}: the state is for the owner and admins`)
    // An admin's own browse and detail reads say so; a student's never do.
    assert.deepEqual(mapListingRow(listing, OTHER, null, { viewerIsAdmin: 'yes' }).images, [], 'only a real true counts')
    for (const viewer of [mapListingRow(listing, OWNER), mapListingRow(listing, ADMIN, null, { viewerIsAdmin: true })]) {
      assert.deepEqual(viewer.images, [A, B], state)
      assert.equal(viewer.imageUrl, A, state)
      assert.equal(viewer.photosPending, state === 'pending')
      assert.equal(viewer.photosReview, state)
    }
  }
  // Approved, and a row from before step 46: everyone sees the photos, nothing is flagged.
  for (const listing of [row(), { id: LISTING, user_id: OWNER, image_url: A, image_urls: [A, B] }]) {
    const stranger = mapListingRow(listing, OTHER)
    assert.deepEqual(stranger.images, [A, B])
    assert.equal(stranger.photosPending, false)
    assert.equal(mapListingRow(listing, OWNER).photosReview, 'approved')
  }
})

test('mapPhotoReviewRow carries what the admin judges and the version approve and reject send back', () => {
  const updatedAt = '2026-10-24T15:04:05.123456+00:00'
  assert.deepEqual(mapPhotoReviewRow(row({ photos_review: 'pending', description: null, hidden: true, created_at: '2026-10-24T12:00:00+00:00', updated_at: updatedAt }), 'Avery'), {
    id: LISTING,
    title: 'Desk',
    description: '',
    category: 'furniture',
    status: 'active',
    hidden: true,
    createdAt: '2026-10-24T12:00:00+00:00',
    updatedAt,
    images: [A, B],
    seller: { id: OWNER, displayName: 'Avery' },
  })
  assert.equal(mapPhotoReviewRow(row()).seller.displayName, null)
})

test('listPendingPhotoReviews reads live pending listings, the longest waiting first, and names the sellers in one query', async () => {
  const rows = [row({ photos_review: 'pending', updated_at: '1' }), row({ id: 'second', user_id: OTHER, photos_review: 'pending', updated_at: '2' }), row({ id: 'third', photos_review: 'pending' })]
  const supabase = fakeSupabase({
    marketplace_listings: () => ({ data: rows, error: null }),
    users: () => ({ data: [{ id: OWNER, display_name: 'Avery' }, { id: OTHER, display_name: '' }], error: null }),
  })
  const listings = await listPendingPhotoReviews(supabase)
  assert.deepEqual(listings.map((l) => [l.id, l.seller.displayName]), [[LISTING, 'Avery'], ['second', null], ['third', 'Avery']])
  const [{ chain }] = supabase.queriesOf('marketplace_listings')
  assert.ok(hasCall(chain, 'eq', 'photos_review', 'pending'))
  assert.ok(hasCall(chain, 'is', 'deleted_at', null))
  assert.ok(hasCall(chain, 'order', 'updated_at', { ascending: true }))
  assert.ok(hasCall(chain, 'limit', PHOTO_REVIEW_QUEUE_LIMIT))
  const users = supabase.queriesOf('users')
  assert.equal(users.length, 1)
  assert.ok(hasCall(users[0].chain, 'in', 'id', [OWNER, OTHER]))

  const empty = fakeSupabase({ marketplace_listings: () => ({ data: [], error: null }) })
  assert.deepEqual(await listPendingPhotoReviews(empty), [])
  assert.equal(empty.queriesOf('users').length, 0, 'no seller lookup for an empty queue')
  await assert.rejects(listPendingPhotoReviews(fakeSupabase({ marketplace_listings: () => ({ data: null, error: MISSING_COLUMN }) })), (err) => err === MISSING_COLUMN)
})

test('decidePhotoReview approves only the pending version the admin saw, and a rejection clears the photos', async () => {
  const now = '2026-10-24T16:00:00.000Z'
  const updatedAt = '2026-10-24T15:04:05.123456+00:00'
  let matched = [{ id: LISTING }]
  let current = { id: LISTING, photos_review: 'pending' }
  const supabase = fakeSupabase({
    marketplace_listings: (chain) => (operation(chain) === 'update' ? { data: matched, error: null } : { data: current, error: null }),
  })
  assert.deepEqual(await decidePhotoReview(supabase, { listingId: LISTING, decision: 'approved', updatedAt, reviewerId: ADMIN, now }), { status: 200 })
  const [approve] = supabase.queriesOf('marketplace_listings')
  assert.deepEqual(approve.chain.find((c) => c.method === 'update').args[0], { photos_review: 'approved', photos_reviewed_at: now, photos_reviewed_by: ADMIN })
  assert.ok(hasCall(approve.chain, 'eq', 'id', LISTING))
  assert.ok(hasCall(approve.chain, 'eq', 'photos_review', 'pending'))
  assert.ok(hasCall(approve.chain, 'eq', 'updated_at', updatedAt))
  assert.ok(hasCall(approve.chain, 'is', 'deleted_at', null))
  assert.equal(supabase.queriesOf('marketplace_listings').length, 1, 'a match needs no second read')

  assert.deepEqual(await decidePhotoReview(supabase, { listingId: LISTING, decision: 'rejected', updatedAt, reviewerId: ADMIN, now }), { status: 200 })
  const reject = supabase.queriesOf('marketplace_listings')[1]
  assert.deepEqual(reject.chain.find((c) => c.method === 'update').args[0], {
    photos_review: 'rejected',
    photos_reviewed_at: now,
    photos_reviewed_by: ADMIN,
    image_url: null,
    image_urls: [],
  })

  // Nothing matched: still pending means the seller edited it since (409),
  // anything else means it left the queue (404).
  matched = []
  assert.deepEqual(await decidePhotoReview(supabase, { listingId: LISTING, decision: 'approved', updatedAt, reviewerId: ADMIN, now }), { status: 409 })
  current = { id: LISTING, photos_review: 'approved' }
  assert.deepEqual(await decidePhotoReview(supabase, { listingId: LISTING, decision: 'approved', updatedAt, reviewerId: ADMIN, now }), { status: 404 })
  current = null
  assert.deepEqual(await decidePhotoReview(supabase, { listingId: LISTING, decision: 'rejected', updatedAt, reviewerId: ADMIN, now }), { status: 404 })
  const lookup = supabase.queriesOf('marketplace_listings').at(-1)
  assert.ok(hasCall(lookup.chain, 'is', 'deleted_at', null))
  assert.ok(hasCall(lookup.chain, 'maybeSingle'))
})

test('countPendingPhotoReviews: the count, 0 for none, and null rather than a throw when it cannot count', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  assert.equal(await countPendingPhotoReviews(fakeSupabase({ marketplace_listings: () => ({ data: [], count: 7, error: null }) })), 7)
  assert.equal(await countPendingPhotoReviews(fakeSupabase({ marketplace_listings: () => ({ data: [], count: null, error: null }) })), 0)
  assert.equal(await countPendingPhotoReviews(fakeSupabase({ marketplace_listings: () => ({ data: null, count: null, error: MISSING_COLUMN }) })), null)
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /photo_review\] schema missing: run db\/supabase-marketplace-photo-review\.sql/)
  // A missing marketplace table: null, nothing logged (the marketplace is not installed).
  const before = log.mock.calls.length
  assert.equal(await countPendingPhotoReviews(fakeSupabase({ marketplace_listings: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.marketplace_listings' in the schema cache" } }) })), null)
  assert.equal(log.mock.calls.length, before)
  // Anything else, a throw included: null, and the route error line.
  assert.equal(await countPendingPhotoReviews(fakeSupabase({})), null)
  assert.equal(log.mock.calls.at(-1).arguments[1], 'GET /api/admin/overview pending photos')
})
