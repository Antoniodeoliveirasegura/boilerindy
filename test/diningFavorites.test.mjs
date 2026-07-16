import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeItemName, MAX_ITEM_NAME } from '../src/diningFavorites.mjs'

// Issue #49 - favorite item names must normalize to a stable key so menu names
// and user input match regardless of case and spacing.

test('lowercases and trims', () => {
  assert.equal(normalizeItemName('  Chicken Tenders  '), 'chicken tenders')
})

test('collapses internal whitespace', () => {
  assert.equal(normalizeItemName('Chicken   Tenders'), 'chicken tenders')
  assert.equal(normalizeItemName('Mac\tand\ncheese'), 'mac and cheese')
})

test('treats case/spacing variants as the same favorite', () => {
  assert.equal(normalizeItemName('PIZZA'), normalizeItemName('  pizza '))
})

test('returns empty string for non-string or empty input', () => {
  assert.equal(normalizeItemName(null), '')
  assert.equal(normalizeItemName(undefined), '')
  assert.equal(normalizeItemName(42), '')
  assert.equal(normalizeItemName('   '), '')
})

test('caps length at MAX_ITEM_NAME', () => {
  const long = 'a'.repeat(MAX_ITEM_NAME + 50)
  assert.equal(normalizeItemName(long).length, MAX_ITEM_NAME)
})
