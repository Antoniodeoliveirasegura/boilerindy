import { describe, expect, test } from 'vitest'
import { normalizeItemName, favoritesOnTodaysMenu } from './diningFavorites'

// Issue #49 — favorites must match the live menu regardless of case/spacing,
// and the "favorites today" section must report which locations serve them.

describe('normalizeItemName', () => {
  test('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeItemName('  Chicken   Tenders ')).toBe('chicken tenders')
  })

  test('returns empty string for unusable input', () => {
    expect(normalizeItemName(null)).toBe('')
    expect(normalizeItemName('   ')).toBe('')
  })
})

const snapshot = [
  {
    name: 'Tower Dining',
    stations: [
      { name: 'Grill', items: [{ name: 'Chicken Tenders' }, { name: 'Fries' }] },
    ],
  },
  {
    name: 'Earhart',
    stations: [
      { name: 'Comfort', items: [{ name: 'chicken tenders' }, { name: 'Soup' }] },
    ],
  },
]

describe('favoritesOnTodaysMenu', () => {
  test('returns empty when there are no favorites', () => {
    expect(favoritesOnTodaysMenu([], snapshot)).toEqual([])
  })

  test('matches a favorite across locations regardless of case', () => {
    const result = favoritesOnTodaysMenu(['chicken tenders'], snapshot)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Chicken Tenders')
    expect(result[0].locations.sort()).toEqual(['Earhart', 'Tower Dining'])
  })

  test('ignores favorites not on any menu', () => {
    expect(favoritesOnTodaysMenu(['sushi'], snapshot)).toEqual([])
  })

  test('handles a Set and missing/empty stations safely', () => {
    const favs = new Set(['soup'])
    const messy = [{ name: 'X' }, ...snapshot]
    const result = favoritesOnTodaysMenu(favs, messy)
    expect(result).toEqual([{ name: 'Soup', locations: ['Earhart'] }])
  })
})
