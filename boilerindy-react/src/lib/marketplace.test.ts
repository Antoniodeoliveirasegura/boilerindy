import { describe, expect, test } from 'vitest'
import { categoryFor, centsToInput, formatPrice, labelForCategory, listingImage, MARKETPLACE_CATEGORIES, parsePriceInput } from './marketplace'

// Issue #32 / #171 - the marketplace page formats listings with these helpers;
// they mirror the mobile app's lib/marketplace.ts so both clients agree.

describe('categoryFor', () => {
  test('resolves canonical slugs, legacy names and unknowns', () => {
    expect(categoryFor('textbooks').slug).toBe('textbooks')
    expect(categoryFor(' Tickets ').slug).toBe('tickets')
    expect(categoryFor('books').slug).toBe('textbooks')
    expect(categoryFor('dorm').slug).toBe('housing')
    expect(categoryFor('bikes').slug).toBe('misc')
    expect(categoryFor(undefined).slug).toBe('misc')
  })
  test('every category has an icon and a tone', () => {
    for (const c of MARKETPLACE_CATEGORIES) {
      expect(c.icon).toBeTruthy()
      expect(['map', 'events', 'bus', 'dining']).toContain(c.tone)
    }
  })
})

describe('labelForCategory', () => {
  test('labels slugs and title-cases anything else', () => {
    expect(labelForCategory('rideshare')).toBe('Rideshare')
    expect(labelForCategory('food')).toBe('Food')
    expect(labelForCategory('')).toBe('')
    expect(labelForCategory(null)).toBe('')
  })
})

describe('formatPrice', () => {
  test('matches the app: whole dollars, cents, free, and no price', () => {
    expect(formatPrice(4500)).toBe('$45')
    expect(formatPrice(1250)).toBe('$12.50')
    expect(formatPrice(0)).toBe('Free')
    expect(formatPrice(null)).toBe('Free / contact')
    expect(formatPrice(undefined)).toBe('Free / contact')
  })
})

describe('parsePriceInput and centsToInput', () => {
  test('round-trips dollars and cents', () => {
    expect(parsePriceInput('45')).toBe(4500)
    expect(parsePriceInput(' $12.50 ')).toBe(1250)
    expect(parsePriceInput('0')).toBe(0)
    expect(parsePriceInput('')).toBeNull()
    expect(parsePriceInput('abc')).toBeUndefined()
    expect(parsePriceInput('-3')).toBeUndefined()
    expect(centsToInput(4500)).toBe('45')
    expect(centsToInput(1250)).toBe('12.50')
    expect(centsToInput(null)).toBe('')
  })
})

describe('listingImage', () => {
  test('returns only a non-empty string url', () => {
    expect(listingImage({ imageUrl: 'https://x.test/a.jpg' })).toBe('https://x.test/a.jpg')
    expect(listingImage({ imageUrl: '' })).toBeNull()
    expect(listingImage({ imageUrl: null })).toBeNull()
  })
})
