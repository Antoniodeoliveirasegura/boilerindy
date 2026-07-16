import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateGuideInput,
  mapGuideRow,
  GUIDE_CATEGORIES,
  MAX_GUIDE_TITLE,
  MAX_GUIDE_BODY,
} from '../src/guideRecommendations.mjs'

// Issue #31 - guide submissions must be validated/coerced before hitting the DB.

test('accepts a valid submission and lowercases the category', () => {
  const { value, error } = validateGuideInput({
    category: 'FOOD',
    title: '  Best tacos near campus  ',
    body: 'Great cheap tacos.',
    placeName: 'Taco Spot',
    lat: 40.42,
    lng: -86.91,
  })
  assert.equal(error, undefined)
  assert.equal(value.category, 'food')
  assert.equal(value.title, 'Best tacos near campus')
  assert.equal(value.place_name, 'Taco Spot')
  assert.equal(value.lat, 40.42)
  assert.equal(value.lng, -86.91)
})

test('rejects an unknown category', () => {
  const { error } = validateGuideInput({ category: 'sports', title: 'x' })
  assert.match(error, /Category must be one of/)
})

test('requires a non-empty title within the limit', () => {
  assert.match(validateGuideInput({ category: 'study', title: '   ' }).error, /Title is required/)
  const long = 'a'.repeat(MAX_GUIDE_TITLE + 1)
  assert.match(validateGuideInput({ category: 'study', title: long }).error, /Title is required/)
})

test('rejects an over-length body', () => {
  const body = 'a'.repeat(MAX_GUIDE_BODY + 1)
  assert.match(validateGuideInput({ category: 'safety', title: 'ok', body }).error, /1000 characters/)
})

test('drops coordinates unless both lat and lng are present', () => {
  const { value } = validateGuideInput({ category: 'parking', title: 'Garage', lat: 40.42 })
  assert.equal(value.lat, null)
  assert.equal(value.lng, null)
})

test('rejects out-of-range coordinates', () => {
  assert.match(validateGuideInput({ category: 'food', title: 'x', lat: 200, lng: 0 }).error, /out of range/)
})

test('GUIDE_CATEGORIES is the canonical list', () => {
  assert.deepEqual(GUIDE_CATEGORIES, ['food', 'study', 'parking', 'safety', 'other'])
})

test('mapGuideRow flags ownership and upvote state', () => {
  const row = {
    id: 'r1', user_id: 'u1', category: 'food', title: 'T', body: 'B',
    place_name: null, lat: null, lng: null, upvote_count: 3, pinned: true, created_at: '2026-06-16T00:00:00Z',
  }
  const mapped = mapGuideRow(row, 'u1', new Set(['r1']))
  assert.equal(mapped.isMine, true)
  assert.equal(mapped.upvotedByMe, true)
  assert.equal(mapped.pinned, true)
  assert.equal(mapped.upvotes, 3)
})
