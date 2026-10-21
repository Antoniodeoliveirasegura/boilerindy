import { describe, expect, test } from 'vitest'
import sitemap from '../../public/sitemap.xml?raw'
import appSource from '../App.tsx?raw'
import {
  PREVIEW_MESSAGE,
  PREVIEW_MESSAGES,
  PREVIEW_PATHS,
  PREVIEW_SIGN_UP_HREF,
  isPreviewPath,
  previewMessage,
  previewSignInHref,
} from './publicPreview'

// Issue #366: signed-out visitors may open the live dining and transit pages,
// the campus map and the free food on campus calendars.

describe('isPreviewPath', () => {
  test('matches the preview routes, with or without a trailing slash', () => {
    expect(isPreviewPath('/dining')).toBe(true)
    expect(isPreviewPath('/transit')).toBe(true)
    expect(isPreviewPath('/transit/')).toBe(true)
    expect(isPreviewPath('/map')).toBe(true)
    expect(isPreviewPath('/free-food/')).toBe(true)
  })

  // The router matches routes in any letter case, so /Dining rendered the
  // dining page signed out with neither the preview bar nor the navbar.
  test('matches in any letter case, like the router', () => {
    expect(isPreviewPath('/Dining')).toBe(true)
    expect(isPreviewPath('/TRANSIT/')).toBe(true)
    expect(isPreviewPath('/Map')).toBe(true)
    expect(isPreviewPath('/Free-Food')).toBe(true)
  })

  test('does not match any other route', () => {
    for (const path of ['/', '/events', '/parking', '/dashboard', '/dining/extra', '/diningx', '/map/extra', '/free', '/schedule']) {
      expect(isPreviewPath(path)).toBe(false)
    }
  })
})

describe('the bar message', () => {
  test('says what the page shows and what an account adds there', () => {
    expect(previewMessage('/dining')).toBe(PREVIEW_MESSAGE)
    expect(previewMessage('/transit/')).toBe(PREVIEW_MESSAGE)
    expect(previewMessage('/map')).toBe(
      "You're previewing the campus map. Create a free account to find each of your classes on it.",
    )
    expect(previewMessage('/Free-Food')).toBe(
      "You're previewing free food on campus. Create a free account to add events from your own calendar.",
    )
    expect(Object.keys(PREVIEW_MESSAGES)).toEqual([...PREVIEW_PATHS])
  })

  test('falls back to the dining and transit message off a preview route', () => {
    expect(previewMessage('/events')).toBe(PREVIEW_MESSAGE)
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
    expect(previewSignInHref('/map', '?building=ET')).toBe('/login?next=%2Fmap%3Fbuilding%3DET')
  })
})

describe('sitemap', () => {
  test('lists every preview route', () => {
    for (const path of PREVIEW_PATHS) {
      expect(sitemap).toContain(`<loc>https://www.boilerindy.app${path}</loc>`)
    }
  })
})

// App.tsx is the guard itself, so it is read as text: every route in the
// AppLayout group is wrapped in RequireAuth except exactly the preview list.
describe('App.tsx', () => {
  test('leaves exactly the preview routes without RequireAuth', () => {
    const group = appSource.slice(appSource.indexOf('<Route element={<AppLayout />}>'))
    expect(group.length).toBeLessThan(appSource.length)
    const routes = group
      .split('<Route')
      .slice(1)
      .map((chunk) => ({ path: /path="(\/[^"]*)"/.exec(chunk)?.[1], guarded: chunk.includes('<RequireAuth>') }))
      .filter((route): route is { path: string; guarded: boolean } => Boolean(route.path))
    expect(routes.length).toBeGreaterThan(PREVIEW_PATHS.length)
    expect(routes.filter((route) => !route.guarded).map((route) => route.path).sort()).toEqual([...PREVIEW_PATHS].sort())
  })
})
