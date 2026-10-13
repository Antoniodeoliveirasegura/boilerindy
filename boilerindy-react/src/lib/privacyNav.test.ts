import { describe, expect, test } from 'vitest'
import { getBackTarget, withFrom } from './privacyNav'

// Issue #56 - the privacy "Back" link must be context-aware so users who arrive
// from signup or Settings are returned to where they came from, not the Landing page.

describe('getBackTarget', () => {
  test('routes signup origin back to the signup tab', () => {
    expect(getBackTarget('signup')).toEqual({ to: '/login?tab=signup', label: '← Back to sign up' })
  })

  test('routes settings origin back to Settings', () => {
    expect(getBackTarget('settings')).toEqual({ to: '/settings', label: '← Back to Settings' })
  })

  test('falls back to Landing for an absent origin', () => {
    expect(getBackTarget(null)).toEqual({ to: '/', label: '← Back to BoilerIndy' })
  })

  test('falls back to Landing for an unknown origin', () => {
    expect(getBackTarget('bogus')).toEqual({ to: '/', label: '← Back to BoilerIndy' })
  })

  // Install's sign-in page link passes from=signin; the page used to say
  // "Back to sign in" to every visitor whatever their entry point.
  test('routes signin origin back to the sign-in form', () => {
    expect(getBackTarget('signin')).toEqual({ to: '/login', label: '← Back to sign in' })
  })

  // The app footer links carry no origin, and "/" is the signed-out marketing
  // page, so a signed-in student goes back into the app instead.
  test('falls back to the dashboard for a signed-in student with no origin', () => {
    expect(getBackTarget(null, true)).toEqual({ to: '/dashboard', label: '← Back to BoilerIndy' })
    expect(getBackTarget('bogus', true)).toEqual({ to: '/dashboard', label: '← Back to BoilerIndy' })
  })

  test('a known origin wins over the signed-in fallback', () => {
    expect(getBackTarget('settings', true)).toEqual({ to: '/settings', label: '← Back to Settings' })
  })

  test('ignores origins that are only Object prototype keys', () => {
    expect(getBackTarget('constructor')).toEqual({ to: '/', label: '← Back to BoilerIndy' })
    expect(getBackTarget('toString', true)).toEqual({ to: '/dashboard', label: '← Back to BoilerIndy' })
  })
})

// The legal pages' cross-links dropped the origin, so Settings -> Privacy ->
// Delete account offered "Back to BoilerIndy" instead of "Back to Settings".
describe('withFrom', () => {
  test('passes a known origin on', () => {
    expect(withFrom('/delete-account', 'settings')).toBe('/delete-account?from=settings')
    expect(withFrom('/terms', 'signin')).toBe('/terms?from=signin')
  })

  test('appends to an existing query string', () => {
    expect(withFrom('/login?tab=signup', 'signup')).toBe('/login?tab=signup&from=signup')
  })

  test('leaves the link alone with no origin', () => {
    expect(withFrom('/support', null)).toBe('/support')
    expect(withFrom('/support', undefined)).toBe('/support')
    expect(withFrom('/support', '')).toBe('/support')
  })

  test('does not pass on an origin getBackTarget would ignore', () => {
    expect(withFrom('/support', 'bogus')).toBe('/support')
    expect(withFrom('/support', 'constructor')).toBe('/support')
  })
})
