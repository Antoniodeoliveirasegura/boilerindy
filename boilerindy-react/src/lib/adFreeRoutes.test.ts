import { describe, expect, it } from 'vitest'
import { AD_FREE_PATHS, isAdFreePath } from './adFreeRoutes'

describe('isAdFreePath', () => {
  it('covers the two pages that list the shared campus events', () => {
    expect([...AD_FREE_PATHS]).toEqual(['/events', '/free-food'])
  })

  it('matches them the way the router does: any case, a trailing slash', () => {
    for (const path of ['/events', '/Events', '/events/', '/free-food', '/FREE-FOOD/']) {
      expect(isAdFreePath(path), path).toBe(true)
    }
  })

  it('leaves every other page with its sponsor rails', () => {
    for (const path of ['/', '/dashboard', '/dining', '/clubs', '/assignments', '/events-archive', '/free']) {
      expect(isAdFreePath(path), path).toBe(false)
    }
  })
})
