import { describe, expect, test } from 'vitest'
import { SHARE_REFS, shareUrl } from './shareLinks'
import { readDiningView, writeDiningView } from './dining'

const SITE = 'https://www.boilerindy.app'

describe('shareUrl', () => {
  test('adds the page ref to the view on screen', () => {
    expect(shareUrl('transit', `${SITE}/transit?route=31`)).toBe(`${SITE}/transit?route=31&ref=share-bus`)
    expect(shareUrl('transit', `${SITE}/transit`)).toBe(`${SITE}/transit?ref=share-bus`)
    expect(shareUrl('dining', `${SITE}/dining?hall=tower-dining&meal=dinner`)).toBe(
      `${SITE}/dining?hall=tower-dining&meal=dinner&ref=share-dining`,
    )
  })

  test('drops a ref already in the address, so a reshared link says it was shared', () => {
    const link = new URL(shareUrl('transit', `${SITE}/transit?ref=landing&route=31&ref=insta`))
    expect(link.searchParams.getAll('ref')).toEqual(['share-bus'])
    expect(link.searchParams.get('route')).toBe('31')
    // A friend who opened a shared link and shares it again.
    expect(shareUrl('dining', `${SITE}/dining?hall=campus-center&ref=share-dining`)).toBe(
      `${SITE}/dining?hall=campus-center&ref=share-dining`,
    )
  })

  test('leaves out anything that is not part of the view', () => {
    expect(shareUrl('transit', `${SITE}/transit?route=27&utm_source=instagram&fbclid=abc#map`)).toBe(
      `${SITE}/transit?route=27&ref=share-bus`,
    )
    expect(shareUrl('dining', `${SITE}/dining?route=31&meal=lunch`)).toBe(`${SITE}/dining?meal=lunch&ref=share-dining`)
  })

  test('takes the view it is given over the address, and null leaves a part out', () => {
    expect(shareUrl('dining', `${SITE}/dining`, { hall: 'tower-dining', meal: 'lunch' })).toBe(
      `${SITE}/dining?hall=tower-dining&meal=lunch&ref=share-dining`,
    )
    expect(shareUrl('dining', `${SITE}/dining?hall=campus-center&meal=dinner`, { hall: 'tower-dining', meal: null })).toBe(
      `${SITE}/dining?hall=tower-dining&ref=share-dining`,
    )
    expect(shareUrl('transit', `${SITE}/transit?route=999`, { route: null })).toBe(`${SITE}/transit?ref=share-bus`)
  })

  test('keeps the origin it was shared from and the page path, whatever the address spelled', () => {
    expect(shareUrl('transit', 'http://localhost:4173/Transit/?route=31')).toBe('http://localhost:4173/transit?route=31&ref=share-bus')
  })

  test('the refs are slugs the sign-up source accepts', () => {
    for (const ref of Object.values(SHARE_REFS)) expect(ref).toMatch(/^[a-z0-9-]{1,40}$/)
  })
})

describe('the dining view in the address', () => {
  test('reads the hall and meal, or null for either one missing or empty', () => {
    expect(readDiningView(new URLSearchParams('hall=tower-dining&meal=dinner'))).toEqual({ hall: 'tower-dining', meal: 'dinner' })
    expect(readDiningView(new URLSearchParams('meal=&ref=share-dining'))).toEqual({ hall: null, meal: null })
  })

  test('writes the hall and meal in place, keeping anything else and taking out a null', () => {
    const params = new URLSearchParams('ref=share-dining&hall=campus-center&meal=lunch')
    expect(writeDiningView(params, { hall: 'tower-dining', meal: 'dinner' }).toString()).toBe(
      'ref=share-dining&hall=tower-dining&meal=dinner',
    )
    expect(writeDiningView(params, { hall: 'tower-dining', meal: null }).toString()).toBe('ref=share-dining&hall=tower-dining')
    // The params it was given are left as they were.
    expect(params.toString()).toBe('ref=share-dining&hall=campus-center&meal=lunch')
  })

  test('a hall and meal round-trip through a shared link', () => {
    for (const view of [
      { hall: 'tower-dining', meal: 'dinner' },
      { hall: 'campus-center', meal: null },
      { hall: 'tower-dining', meal: 'late-night' },
    ]) {
      const onScreen = `${SITE}/dining?${writeDiningView(new URLSearchParams('ref=landing'), view)}`
      const link = new URL(shareUrl('dining', onScreen))
      expect(link.pathname).toBe('/dining')
      expect(readDiningView(link.searchParams)).toEqual(view)
      expect(link.searchParams.get('ref')).toBe('share-dining')
    }
  })
})
