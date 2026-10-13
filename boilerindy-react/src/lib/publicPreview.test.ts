import { describe, expect, test } from 'vitest'
import sitemap from '../../public/sitemap.xml?raw'
import { PREVIEW_PATHS, PREVIEW_SIGN_UP_HREF, isPreviewPath, previewSignInHref } from './publicPreview'

// Issue #366: signed-out visitors may open the live dining and transit pages.

describe('isPreviewPath', () => {
  test('matches the preview routes, with or without a trailing slash', () => {
    expect(isPreviewPath('/dining')).toBe(true)
    expect(isPreviewPath('/transit')).toBe(true)
    expect(isPreviewPath('/transit/')).toBe(true)
  })

  // The router matches routes in any letter case, so /Dining rendered the
  // dining page signed out with neither the preview bar nor the navbar.
  test('matches in any letter case, like the router', () => {
    expect(isPreviewPath('/Dining')).toBe(true)
    expect(isPreviewPath('/TRANSIT/')).toBe(true)
  })

  test('does not match any other route', () => {
    for (const path of ['/', '/events', '/parking', '/dashboard', '/dining/extra', '/diningx']) {
      expect(isPreviewPath(path)).toBe(false)
    }
  })
})

describe('preview links', () => {
  test('sign-up carries no next, so a new account still goes through /setup', () => {
    expect(PREVIEW_SIGN_UP_HREF).toBe('/login?tab=signup')
    expect(PREVIEW_SIGN_UP_HREF).not.toContain('next=')
  })

  test('sign-in comes back to the previewed page', () => {
    expect(previewSignInHref('/dining')).toBe('/login?next=%2Fdining')
    expect(previewSignInHref('/transit', '?route=1')).toBe('/login?next=%2Ftransit%3Froute%3D1')
  })
})

describe('sitemap', () => {
  test('lists every preview route', () => {
    for (const path of PREVIEW_PATHS) {
      expect(sitemap).toContain(`<loc>https://www.boilerindy.app${path}</loc>`)
    }
  })
})
