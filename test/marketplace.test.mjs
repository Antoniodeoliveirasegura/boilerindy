import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateListingInput,
  mapListingRow,
  MARKETPLACE_CATEGORIES,
  MAX_LISTING_TITLE,
} from '../src/marketplace.mjs'

// Issue #32 — listing validation and row mapping (contact only on detail).

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
