import { describe, expect, test } from 'vitest'
import {
  categoryFor,
  centsToInput,
  formatPrice,
  labelForCategory,
  listingImage,
  listingImages,
  MARKETPLACE_CATEGORIES,
  ownerPhotoNote,
  parseImageLinks,
  parsePriceInput,
  photosAwaitReview,
  priceModeOf,
} from './marketplace'

// Issue #32 / #171 / #177 - the marketplace page formats listings with these
// helpers; they mirror the mobile app's lib/marketplace.ts so both clients agree.

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
  test('matches the app: whole dollars, cents, free, best offer, and unspecified', () => {
    expect(formatPrice(4500)).toBe('$45')
    expect(formatPrice(1250)).toBe('$12.50')
    expect(formatPrice(0)).toBe('Free')
    expect(formatPrice(2500, 'free')).toBe('Free')
    expect(formatPrice(null, 'best_offer')).toBe('Best offer')
    expect(formatPrice(null)).toBe('Contact for price')
    expect(formatPrice(undefined, 'fixed')).toBe('Contact for price')
  })
})

describe('priceModeOf', () => {
  test('trusts a valid mode and infers one for older rows', () => {
    expect(priceModeOf({ priceCents: 2500, priceMode: 'best_offer' })).toBe('best_offer')
    expect(priceModeOf({ priceCents: 0 })).toBe('free')
    expect(priceModeOf({ priceCents: 2500 })).toBe('fixed')
    expect(priceModeOf({ priceCents: null, priceMode: 'weird' })).toBe('fixed')
  })
})

describe('parsePriceInput and centsToInput', () => {
  test('round-trips dollars and cents', () => {
    expect(parsePriceInput('45')).toBe(4500)
    expect(parsePriceInput(' $12.50 ')).toBe(1250)
    expect(parsePriceInput('.5')).toBe(50)
    expect(parsePriceInput('0')).toBe(0)
    expect(parsePriceInput('')).toBeNull()
    expect(parsePriceInput('abc')).toBeUndefined()
    expect(parsePriceInput('-3')).toBeUndefined()
    expect(parsePriceInput('12.345')).toBeUndefined()
    expect(centsToInput(4500)).toBe('45')
    expect(centsToInput(1250)).toBe('12.50')
    expect(centsToInput(null)).toBe('')
  })
})

describe('parseImageLinks', () => {
  test('trims, drops blanks and duplicates, keeps order', () => {
    expect(parseImageLinks(' https://x.test/a.jpg \n\nhttps://x.test/b.jpg\nhttps://x.test/a.jpg\n')).toEqual([
      'https://x.test/a.jpg',
      'https://x.test/b.jpg',
    ])
    expect(parseImageLinks('')).toEqual([])
  })
})

describe('listingImages and listingImage', () => {
  test('prefer the gallery, fall back to the legacy cover, drop junk', () => {
    expect(listingImages({ images: ['https://x.test/a.jpg', 'https://x.test/b.jpg'], imageUrl: 'https://x.test/old.jpg' })).toEqual([
      'https://x.test/a.jpg',
      'https://x.test/b.jpg',
    ])
    expect(listingImages({ images: [], imageUrl: 'https://x.test/old.jpg' })).toEqual(['https://x.test/old.jpg'])
    expect(listingImages({ images: ['', null as unknown as string], imageUrl: null })).toEqual([])
    expect(listingImage({ imageUrl: 'https://x.test/a.jpg' })).toBe('https://x.test/a.jpg')
    expect(listingImage({ imageUrl: '' })).toBeNull()
    expect(listingImage({ imageUrl: null })).toBeNull()
  })
})

// Photo review (#504): the API leaves waiting photos out for other students
// and flags the listing; their owner and admins still get the photos.
describe('photosAwaitReview', () => {
  test('is true only for a waiting listing that came without photos', () => {
    expect(photosAwaitReview({ photosPending: true, images: [], imageUrl: null })).toBe(true)
    expect(photosAwaitReview({ photosPending: true })).toBe(true)
    // The owner's or an admin's view: the photos are there, so they show.
    expect(photosAwaitReview({ photosPending: true, images: ['https://x.test/a.jpg'] })).toBe(false)
    expect(photosAwaitReview({ photosPending: false, images: [] })).toBe(false)
    // An older server sends no flag at all.
    expect(photosAwaitReview({ images: [] })).toBe(false)
  })
})

describe('ownerPhotoNote', () => {
  test('tells the owner their photos wait, or that an admin removed them, and nobody else anything', () => {
    expect(ownerPhotoNote({ isMine: true, photosPending: true, photosReview: 'pending' })).toBe(
      'Your photos are waiting for review. Until then other students see the listing without them.',
    )
    expect(ownerPhotoNote({ isMine: true, photosPending: false, photosReview: 'rejected' })).toBe(
      "An admin removed this listing's photos. You can add new ones.",
    )
    expect(ownerPhotoNote({ isMine: true, photosPending: false, photosReview: 'approved' })).toBeNull()
    expect(ownerPhotoNote({ isMine: true })).toBeNull()
    expect(ownerPhotoNote({ isMine: false, photosPending: true })).toBeNull()
    expect(ownerPhotoNote({ photosPending: true, photosReview: 'pending' })).toBeNull()
  })
})
