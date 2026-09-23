import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  validateListingInput,
  mapListingRow,
  isMissingGalleryPricingColumn,
  evaluateReportTarget,
  parseReportInput,
  shouldAutoHide,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_GALLERY_PRICING_COLUMNS,
  MARKETPLACE_GALLERY_PRICING_SQL_FILE,
  MAX_LISTING_TITLE,
  MAX_REPORT_REASON,
  REPORT_REASONS,
  REPORTS_TO_HIDE,
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

// Issue #204: a report used to go straight to the insert with an optional,
// free-text reason, so a soft-deleted or unknown id came back as a foreign-key
// 500 and a seller could report their own listing. These helpers are what the
// route checks first.

test('parseReportInput requires a reason from the enum', () => {
  assert.deepEqual(parseReportInput({}), { ok: false, message: 'Choose a reason for the report.' })
  assert.deepEqual(parseReportInput({ reason: '   ' }), { ok: false, message: 'Choose a reason for the report.' })
  assert.match(parseReportInput({ reason: 'because I say so' }).message, /Reason must be one of/)
  assert.match(parseReportInput({ reason: 'libel: it is untrue' }).message, /Reason must be one of/)
  for (const reason of REPORT_REASONS) {
    assert.deepEqual(parseReportInput({ reason }), { ok: true, reason })
  }
  assert.deepEqual(parseReportInput({ reason: '  SPAM  ' }), { ok: true, reason: 'spam' })
})

test('parseReportInput takes the website\'s flattened string and a split body alike', () => {
  // What Marketplace.tsx sends today (#224): one field, details after the colon.
  assert.deepEqual(parseReportInput({ reason: 'other: never shipped the book' }), {
    ok: true,
    reason: 'other: never shipped the book',
  })
  // What a client sending separate fields would send.
  assert.deepEqual(parseReportInput({ reason: 'other', details: 'never shipped the book' }), {
    ok: true,
    reason: 'other: never shipped the book',
  })
  // Details are allowed on any reason, and a colon inside them survives.
  assert.deepEqual(parseReportInput({ reason: 'scam', details: 'asked for Zelle: no meetup' }), {
    ok: true,
    reason: 'scam: asked for Zelle: no meetup',
  })
  // An explicit details field wins over anything trailing the colon.
  assert.deepEqual(parseReportInput({ reason: 'other: ignored', details: 'used' }), { ok: true, reason: 'other: used' })
  // "other" with nothing to say stays a bare reason rather than a dangling colon.
  assert.deepEqual(parseReportInput({ reason: 'other:   ' }), { ok: true, reason: 'other' })
})

test('parseReportInput cuts the stored reason to the column width', () => {
  const { ok, reason } = parseReportInput({ reason: 'other', details: 'x'.repeat(MAX_REPORT_REASON * 2) })
  assert.equal(ok, true)
  assert.equal(reason.length, MAX_REPORT_REASON)
  assert.ok(reason.startsWith('other: '))
  // db/supabase-marketplace.sql declares CHECK (char_length(reason) <= 500);
  // going over it is a 500 from Postgres, not a validation message.
  const sql = readFileSync(new URL('../db/supabase-marketplace.sql', import.meta.url), 'utf8')
  assert.match(sql, new RegExp(`char_length\\(reason\\) <= ${MAX_REPORT_REASON}`))
})

test('evaluateReportTarget rejects an unknown listing and a self-report', () => {
  assert.deepEqual(evaluateReportTarget({ listing: null, reporterId: 'u1' }), {
    status: 404,
    message: 'Listing not found.',
  })
  assert.deepEqual(evaluateReportTarget({}), { status: 404, message: 'Listing not found.' })
  assert.deepEqual(evaluateReportTarget({ listing: { user_id: 'u1' }, reporterId: 'u1' }), {
    status: 400,
    message: 'You cannot report your own listing.',
  })
  assert.deepEqual(evaluateReportTarget({ listing: { user_id: 'u2' }, reporterId: 'u1' }), { status: 200 })
})

test('shouldAutoHide fires at the threshold, not before, and survives a missing count', () => {
  assert.equal(shouldAutoHide(REPORTS_TO_HIDE - 1), false)
  assert.equal(shouldAutoHide(REPORTS_TO_HIDE), true)
  assert.equal(shouldAutoHide(REPORTS_TO_HIDE + 5), true)
  // Supabase answers { count: null } when the head request cannot count.
  assert.equal(shouldAutoHide(null), false)
  assert.equal(shouldAutoHide(undefined), false)
})

test('mapListingRow exposes hidden to everyone and the report count to the owner only', () => {
  const row = { id: 'l1', user_id: 'u1', title: 'T', category: 'misc', status: 'active', hidden: true }
  const owner = mapListingRow(row, 'u1', null, { reportCount: 3 })
  assert.equal(owner.hidden, true)
  assert.equal(owner.reportCount, 3)
  const stranger = mapListingRow(row, 'u2', null, { reportCount: 3 })
  assert.equal(stranger.hidden, true)
  assert.equal(stranger.reportCount, undefined, 'a report count must never reach a non-owner')
  // A live listing is mapped without a count, and the field stays off the payload.
  assert.equal(mapListingRow({ ...row, hidden: false }, 'u1').hidden, false)
  assert.equal(mapListingRow({ ...row, hidden: false }, 'u1').reportCount, undefined)
  // A row read before the migration that added `hidden` maps to false, not undefined.
  assert.equal(mapListingRow({ id: 'l2', user_id: 'u1' }, 'u1').hidden, false)
})
