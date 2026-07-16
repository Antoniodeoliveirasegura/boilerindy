import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  haversineMiles,
  isDealActive,
  validateDealInput,
  mapDealRow,
  CAMPUS_COORDS,
  DEAL_CATEGORIES,
} from '../src/campusDeals.mjs'

// Issue #24 - distance, active-window, and validation for admin-curated deals.

test('haversine is ~0 for the same point and positive for distinct points', () => {
  assert.equal(Math.round(haversineMiles(39.774, -86.172, 39.774, -86.172)), 0)
  const d = haversineMiles(CAMPUS_COORDS.lat, CAMPUS_COORDS.lng, 39.7684, -86.1581)
  assert.ok(d > 0 && d < 2, `expected a small positive distance, got ${d}`)
})

test('isDealActive respects active flag and expiry', () => {
  const now = new Date('2026-06-16T00:00:00Z')
  assert.equal(isDealActive({ active: true, expires_at: null }, now), true)
  assert.equal(isDealActive({ active: false, expires_at: null }, now), false)
  assert.equal(isDealActive({ active: true, expires_at: '2026-06-15T00:00:00Z' }, now), false)
  assert.equal(isDealActive({ active: true, expires_at: '2026-06-17T00:00:00Z' }, now), true)
})

test('validateDealInput requires name and a valid category', () => {
  assert.match(validateDealInput({ category: 'food' }).error, /Business name is required/)
  assert.match(validateDealInput({ businessName: 'X', category: 'sports' }).error, /Category must be one of/)
})

test('validateDealInput coerces fields and rejects bad image URLs', () => {
  const { value, error } = validateDealInput({
    businessName: '  Joe Coffee ',
    description: 'BOGO lattes',
    category: 'COFFEE',
    imageUrl: 'https://x.test/a.jpg',
    address: '123 Main',
  })
  assert.equal(error, undefined)
  assert.equal(value.business_name, 'Joe Coffee')
  assert.equal(value.category, 'coffee')
  assert.equal(value.image_url, 'https://x.test/a.jpg')
  assert.match(validateDealInput({ businessName: 'X', category: 'food', imageUrl: 'javascript:alert(1)' }).error, /valid http/)
})

test('validateDealInput partial mode allows missing required fields', () => {
  const { value, error } = validateDealInput({ featured: true }, { partial: true })
  assert.equal(error, undefined)
  assert.equal(value.featured, true)
})

test('mapDealRow adds distance when coordinates are present', () => {
  const mapped = mapDealRow({
    id: 'd1', business_name: 'B', description: '', category: 'food',
    lat: 39.7684, lng: -86.1581, active: true, created_at: '2026-06-16T00:00:00Z',
  })
  assert.ok(mapped.distanceMiles > 0)
  const noCoords = mapDealRow({ id: 'd2', business_name: 'B', category: 'food', lat: null, lng: null })
  assert.equal(noCoords.distanceMiles, null)
})

test('DEAL_CATEGORIES is the canonical list', () => {
  assert.deepEqual(DEAL_CATEGORIES, ['food', 'coffee', 'entertainment', 'services', 'other'])
})
