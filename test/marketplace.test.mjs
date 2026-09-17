import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  validateListingInput,
  mapListingRow,
  isMissingGalleryPricingColumn,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_GALLERY_PRICING_COLUMNS,
  MARKETPLACE_GALLERY_PRICING_SQL_FILE,
  MAX_LISTING_TITLE,
} from '../src/marketplace.mjs'

// Issue #32 - listing validation and row mapping (contact only on detail).

test('requires a title and a valid category', () => {
  assert.match(validateListingInput({ category: 'textbooks' }).error, /Title is required/)
  assert.match(validateListingInput({ title: 'X', category: 'cars' }).error, /Category must be one of/)
})

test('coerces fields and lowercases category', () => {
  const { value, error } = validateListingInput({
    title: '  Calc textbook ',
    description: 'Like new',
    category: 'TEXTBOOKS',
    priceCents: 1500,
    imageUrl: 'https://x.test/b.jpg',
  })
  assert.equal(error, undefined)
  assert.equal(value.title, 'Calc textbook')
  assert.equal(value.category, 'textbooks')
  assert.equal(value.price_cents, 1500)
})

test('rejects bad price, image URL, and status', () => {
  assert.match(validateListingInput({ title: 'X', category: 'misc', priceCents: -5 }).error, /Price/)
  assert.match(validateListingInput({ title: 'X', category: 'misc', imageUrl: 'javascript:1' }).error, /valid http/)
  assert.match(validateListingInput({ title: 'X', category: 'misc', status: 'gone' }).error, /Status/)
})

test('partial mode allows status-only updates (mark sold)', () => {
  const { value, error } = validateListingInput({ status: 'sold' }, { partial: true })
  assert.equal(error, undefined)
  assert.equal(value.status, 'sold')
})

test('rejects an over-length title', () => {
  const long = 'a'.repeat(MAX_LISTING_TITLE + 1)
  assert.match(validateListingInput({ title: long, category: 'misc' }).error, /Title is required/)
})

test('mapListingRow hides contact in list view, shows it on detail', () => {
  const row = { id: 'l1', user_id: 'u1', title: 'T', description: '', category: 'misc', price_cents: 500, status: 'active', created_at: '2026-06-16T00:00:00Z' }
  const listView = mapListingRow(row, 'u2')
  assert.equal(listView.sellerEmail, undefined)
  assert.equal(listView.isMine, false)
  const detailView = mapListingRow(row, 'u1', { name: 'Alex', email: 'alex@purdue.edu' })
  assert.equal(detailView.sellerEmail, 'alex@purdue.edu')
  assert.equal(detailView.isMine, true)
})

test('MARKETPLACE_CATEGORIES is the canonical list', () => {
  assert.deepEqual(MARKETPLACE_CATEGORIES, ['textbooks', 'furniture', 'electronics', 'housing', 'rideshare', 'tutoring', 'tickets', 'misc'])
})

test('normalizes zero, free and best offer, preserving pricing on unrelated patches', () => {
  const validate = (body) => validateListingInput(body, { partial: true })
  assert.deepEqual(validate({ priceCents: 0 }).value, { price_cents: 0, price_mode: 'free' })
  assert.deepEqual(validate({ priceMode: 'best_offer', priceCents: 2500 }).value, { price_cents: null, price_mode: 'best_offer' })
  assert.deepEqual(validate({ priceMode: 'free', priceCents: 2500 }).value, { price_cents: 0, price_mode: 'free' })
  assert.deepEqual(validate({ status: 'sold' }).value, { status: 'sold' })
  assert.ok(validate({ priceMode: 'best deal' }).error)
  assert.equal(mapListingRow({ price_cents: 0 }).priceMode, 'free')
  assert.deepEqual(mapListingRow({ image_url: 'old' }).images, ['old'])
  assert.deepEqual(mapListingRow({ image_url: 'a', image_urls: ['a', 'b'] }).images, ['a', 'b'])
})

// Issue #218: a database without the gallery and pricing migration answers
// marketplace_schema_missing, and the log must name the file that adds the
// missing column rather than the base marketplace file.
test('a missing gallery or pricing column is matched to the migration that adds it', () => {
  const pgrst204 = (column) => ({ code: 'PGRST204', message: `Could not find the '${column}' column of 'marketplace_listings' in the schema cache` })
  const pg42703 = (column) => ({ code: '42703', message: `column marketplace_listings.${column} does not exist` })
  for (const column of ['image_urls', 'price_mode']) {
    assert.equal(isMissingGalleryPricingColumn(pgrst204(column)), true, column)
    assert.equal(isMissingGalleryPricingColumn(pg42703(column)), true, column)
  }
  // image_url comes from the base file and deleted_at from the soft-delete file.
  assert.equal(isMissingGalleryPricingColumn(pg42703('image_url')), false)
  assert.equal(isMissingGalleryPricingColumn(pgrst204('image_url')), false)
  assert.equal(isMissingGalleryPricingColumn(pgrst204('deleted_at')), false)
  assert.equal(isMissingGalleryPricingColumn({ code: 'PGRST205', message: "Could not find the table 'public.marketplace_listings' in the schema cache" }), false)
  assert.equal(isMissingGalleryPricingColumn({ code: '23505', message: 'duplicate key value on price_mode' }), false)
  assert.equal(isMissingGalleryPricingColumn(null), false)

  const sql = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const galleryPricing = sql(MARKETPLACE_GALLERY_PRICING_SQL_FILE)
  const base = sql('db/supabase-marketplace.sql')
  for (const column of MARKETPLACE_GALLERY_PRICING_COLUMNS) {
    assert.match(galleryPricing, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`), column)
    assert.doesNotMatch(base, new RegExp(`\\b${column}\\b`), column)
  }
})
