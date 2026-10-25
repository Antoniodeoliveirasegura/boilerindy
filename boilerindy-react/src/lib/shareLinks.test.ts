import { describe, expect, test } from 'vitest'
import { SHARE_REFS, eventLinkParam, linkedEventId, shareUrl } from './shareLinks'
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

describe('a free-food link', () => {
  const EVENT = '5b0c1d4e-8f7a-4c2b-9e3d-1a2b3c4d5e6f'

  test('shares the list, without the event a shared link opened it on', () => {
    expect(shareUrl('free-food', `${SITE}/free-food`)).toBe(`${SITE}/free-food?ref=share-free-food`)
    expect(shareUrl('free-food', `${SITE}/free-food?event=${EVENT}&ref=share-free-food`, { event: null })).toBe(
      `${SITE}/free-food?ref=share-free-food`,
    )
  })

  test('shares one event by the id it is listed under, with the free-food ref', () => {
    expect(shareUrl('free-food', `${SITE}/free-food?utm_source=instagram&ref=flyer-a`, { event: eventLinkParam(`campus:${EVENT}`) })).toBe(
      `${SITE}/free-food?event=${EVENT}&ref=share-free-food`,
    )
  })

  test("names only a shared campus event, never a student's own row", () => {
    expect(eventLinkParam(`campus:${EVENT}`)).toBe(EVENT)
    expect(eventLinkParam('ev-1')).toBeNull()
    expect(eventLinkParam('campus:')).toBeNull()
  })

  test('the event round-trips through a shared link, and a link without one names none', () => {
    const link = new URL(shareUrl('free-food', `${SITE}/free-food`, { event: eventLinkParam('campus:fuel-up') }))
    expect(link.pathname).toBe('/free-food')
    expect(linkedEventId(link.searchParams.get('event'))).toBe('campus:fuel-up')
    expect(linkedEventId(null)).toBeNull()
    expect(linkedEventId(' ')).toBeNull()
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
