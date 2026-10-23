import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { captureSignupRef, clearSignupRef, readSignupRef, signupRefField } from './signupRef'

// The sign-up source the tab holds until an account request carries it
// (docs/analytics.md). The slug rule itself is tested with the API, in
// test/signupRef.test.mjs; these pin the browser side.

const KEY = 'boilerindy-signup-ref'

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('captureSignupRef', () => {
  test('keeps a ?ref= as its slug, in sessionStorage only', () => {
    expect(captureSignupRef('?ref=Flyer_A')).toBe('flyer-a')
    expect(sessionStorage.getItem(KEY)).toBe('flyer-a')
    expect(readSignupRef()).toBe('flyer-a')
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(document.cookie).toBe('')
  })

  test('accepts a utm_source, and prefers ?ref= when a link has both', () => {
    expect(captureSignupRef('?utm_source=Instagram&utm_medium=bio')).toBe('instagram')
    expect(readSignupRef()).toBe('instagram')
    expect(captureSignupRef('?utm_source=instagram&ref=amb-jane')).toBe('amb-jane')
    expect(readSignupRef()).toBe('amb-jane')
  })

  test('a page without a usable ref keeps the one already held; a new tagged link replaces it', () => {
    captureSignupRef('?ref=flyer-a')
    for (const search of ['', '?tab=signup', '?ref=', '?ref=jane%40purdue.edu', '?code=oauth-code']) {
      expect(captureSignupRef(search)).toBeNull()
      expect(readSignupRef()).toBe('flyer-a')
    }
    captureSignupRef('?ref=flyer-b')
    expect(readSignupRef()).toBe('flyer-b')
  })

  test('a browser that refuses storage still loads the page', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(captureSignupRef('?ref=flyer-a')).toBe('flyer-a')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(readSignupRef()).toBeNull()
    expect(signupRefField()).toEqual({})
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(() => clearSignupRef()).not.toThrow()
  })
})

describe('readSignupRef', () => {
  test('reads a stored value through the slug rule, so an edited one cannot reach the API raw', () => {
    sessionStorage.setItem(KEY, 'Flyer A')
    expect(readSignupRef()).toBe('flyer-a')
    sessionStorage.setItem(KEY, 'someone@example.com')
    expect(readSignupRef()).toBeNull()
    sessionStorage.setItem(KEY, 'x'.repeat(200))
    expect(readSignupRef()).toBe('x'.repeat(40))
  })
})

describe('signupRefField and clearSignupRef', () => {
  test('the body field is there only while a ref is held, and clearing drops it', () => {
    expect(signupRefField()).toEqual({})
    captureSignupRef('?ref=amb-jane')
    expect(signupRefField()).toEqual({ signupRef: 'amb-jane' })
    clearSignupRef()
    expect(sessionStorage.getItem(KEY)).toBeNull()
    expect(signupRefField()).toEqual({})
  })
})
