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
  // The morning after the 15th on campus: a deal for the 15th has ended, one
  // for the 17th has not. (At 00:00Z on the 16th it is still the evening of the
  // 15th in Indianapolis, when a deal for the 15th is rightly still listed.)
  const now = new Date('2026-06-16T12:00:00Z')
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

// A picked expiry day used to be stored as midnight UTC, which is the evening
// before in Indianapolis: the card showed the day before and the deal left the
// list the evening before. It now runs to the end of the picked day on campus.
test('validateDealInput stores a picked expiry day as 23:59 that day in campus time', () => {
  assert.equal(validateDealInput({ expiresAt: '2026-10-31' }, { partial: true }).value.expires_at, '2026-11-01T03:59:00.000Z') // EDT
  assert.equal(validateDealInput({ expiresAt: '2026-12-31' }, { partial: true }).value.expires_at, '2027-01-01T04:59:00.000Z') // EST
  // An exact instant (no form sends one, but the API takes it) is kept as given.
  assert.equal(validateDealInput({ expiresAt: '2026-10-31T17:00:00Z' }, { partial: true }).value.expires_at, '2026-10-31T17:00:00.000Z')
  assert.equal(validateDealInput({ expiresAt: '' }, { partial: true }).value.expires_at, null)
  assert.match(validateDealInput({ expiresAt: 'not a date' }, { partial: true }).error, /Expiry date is invalid/)
})

test('a deal expiring on a picked day stays listed through that whole day on campus', () => {
  const deal = { active: true, expires_at: validateDealInput({ expiresAt: '2026-10-31' }, { partial: true }).value.expires_at }
  assert.equal(isDealActive(deal, new Date('2026-10-30T21:00:00-04:00')), true, 'the evening before')
  assert.equal(isDealActive(deal, new Date('2026-10-31T23:00:00-04:00')), true, 'late on the day itself')
  assert.equal(isDealActive(deal, new Date('2026-11-01T00:00:00-04:00')), false, 'the next day')
})

// Deals saved before the end-of-day rule hold 00:00 UTC of the picked day.
// They are read as the end of that day on campus, so they no longer leave the
// list the evening before or show the previous day, and a re-save keeps the day.
test('a deal saved before the end-of-day rule still runs through its picked day', () => {
  const legacy = { active: true, expires_at: '2026-10-31T00:00:00+00:00' }
  assert.equal(isDealActive(legacy, new Date('2026-10-30T21:00:00-04:00')), true, 'the evening before')
  assert.equal(isDealActive(legacy, new Date('2026-10-31T23:00:00-04:00')), true, 'late on the day itself')
  assert.equal(isDealActive(legacy, new Date('2026-11-01T00:30:00-04:00')), false, 'the next day')
  assert.equal(mapDealRow({ ...legacy, id: 'd1', business_name: 'X', category: 'food' }).expiresAt, '2026-11-01T03:59:00.000Z')
  // An exact instant that is not midnight UTC is kept as given.
  assert.equal(mapDealRow({ id: 'd2', business_name: 'X', category: 'food', expires_at: '2026-10-31T17:00:00Z' }).expiresAt, '2026-10-31T17:00:00.000Z')
  assert.equal(mapDealRow({ id: 'd3', business_name: 'X', category: 'food', expires_at: null }).expiresAt, null)
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
