import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countMarketplaceReports, findOwnedMarketplaceListing, respondMarketplaceDbError } from '../src/marketplaceDb.mjs'
import { MARKETPLACE_GALLERY_PRICING_SQL_FILE } from '../src/marketplace.mjs'
import { PhotoError } from '../src/marketplacePhotos.mjs'
import { fakeSupabase, hasCall } from './routes/fakeSupabase.mjs'

// Issue #191: the marketplace database helpers the router and the admin
// hidden-listing routes in server.mjs share, moved out of server.mjs with the
// marketplace router. The two readers take the Supabase client first.

const USER = '11111111-1111-4111-8111-111111111111'
const LISTING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_LISTING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

test('countMarketplaceReports groups the count and the reasons per listing', async () => {
  const supabase = fakeSupabase({
    marketplace_reports: () => ({
      data: [
        { listing_id: LISTING, reason: 'spam' },
        { listing_id: LISTING, reason: 'other: never shipped' },
        { listing_id: OTHER_LISTING, reason: 'scam' },
        { listing_id: LISTING, reason: '' },
      ],
      error: null,
    }),
  })
  const counts = await countMarketplaceReports(supabase, [LISTING, OTHER_LISTING])
  assert.deepEqual(Object.fromEntries(counts), {
    [LISTING]: { count: 3, reasons: ['spam', 'other: never shipped'] },
    [OTHER_LISTING]: { count: 1, reasons: ['scam'] },
  })
  const [{ chain }] = supabase.queriesOf('marketplace_reports')
  assert.ok(hasCall(chain, 'select', 'listing_id, reason'))
  assert.ok(hasCall(chain, 'in', 'listing_id', [LISTING, OTHER_LISTING]))
})

test('countMarketplaceReports issues no query for an empty list and throws a database error', async () => {
  const quiet = fakeSupabase({})
  const none = await countMarketplaceReports(quiet, [])
  assert.equal(none.size, 0)
  assert.equal(quiet.queries.length, 0)

  const failing = fakeSupabase({ marketplace_reports: () => ({ data: null, error: { code: '42P01', message: 'missing' } }) })
  await assert.rejects(countMarketplaceReports(failing, [LISTING]), (err) => err.code === '42P01')
})

test('findOwnedMarketplaceListing reads the caller\'s live listing, null when there is none, and throws on error', async () => {
  const row = { id: LISTING, user_id: USER }
  const supabase = fakeSupabase({ marketplace_listings: () => ({ data: row, error: null }) })
  assert.deepEqual(await findOwnedMarketplaceListing(supabase, LISTING, USER), row)
  const [{ chain }] = supabase.queriesOf('marketplace_listings')
  assert.ok(hasCall(chain, 'eq', 'id', LISTING))
  assert.ok(hasCall(chain, 'eq', 'user_id', USER))
  assert.ok(hasCall(chain, 'is', 'deleted_at', null))
  assert.ok(hasCall(chain, 'maybeSingle'))

  const missing = fakeSupabase({ marketplace_listings: () => ({ data: null, error: null }) })
  assert.equal(await findOwnedMarketplaceListing(missing, LISTING, USER), null)
  const failing = fakeSupabase({ marketplace_listings: () => ({ data: null, error: { code: '500', message: 'down' } }) })
  await assert.rejects(findOwnedMarketplaceListing(failing, LISTING, USER), (err) => err.message === 'down')
})

test('respondMarketplaceDbError answers a PhotoError with its own status and message', () => {
  const res = mockRes()
  respondMarketplaceDbError(res, new PhotoError('Listing not found or not yours.', 404))
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.body, { error: { message: 'Listing not found or not yours.', status: 404 } })
})

test('respondMarketplaceDbError: a missing gallery or pricing column, or deleted_at, answers marketplace_schema_missing and logs its file', (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const schemaMissing = { error: { message: 'The marketplace is not set up yet. Please try again later.', code: 'marketplace_schema_missing', status: 503 } }
  for (const [err, file] of [
    [{ code: '42703', message: 'column marketplace_listings.image_urls does not exist' }, MARKETPLACE_GALLERY_PRICING_SQL_FILE],
    [{ code: 'PGRST204', message: "Could not find the 'price_mode' column of 'marketplace_listings' in the schema cache" }, MARKETPLACE_GALLERY_PRICING_SQL_FILE],
    [{ code: '42703', message: 'column marketplace_listings.deleted_at does not exist' }, 'db/supabase-soft-delete.sql'],
    [{ code: 'PGRST205', message: "Could not find the table 'public.marketplace_listings' in the schema cache" }, 'db/supabase-marketplace.sql'],
  ]) {
    const res = mockRes()
    respondMarketplaceDbError(res, err)
    assert.equal(res.statusCode, 503, err.message)
    assert.deepEqual(res.body, schemaMissing)
    assert.ok(String(log.mock.calls.at(-1).arguments[0]).includes(`run ${file} in`), `${err.message} names ${file}`)
  }
})

test('respondMarketplaceDbError answers any other error with the marketplace fallback 500', (t) => {
  t.mock.method(console, 'error', () => {})
  const res = mockRes()
  respondMarketplaceDbError(res, { code: '23514', message: 'new row violates check constraint' })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { error: { message: 'Could not load the marketplace. Please try again.', status: 500 } })
})
