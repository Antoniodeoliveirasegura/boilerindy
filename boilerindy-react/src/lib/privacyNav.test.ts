import { describe, expect, test } from 'vitest'
import { getBackTarget } from './privacyNav'

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
})
