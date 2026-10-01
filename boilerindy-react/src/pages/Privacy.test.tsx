import { afterEach, describe, expect, test } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Privacy from './Privacy'

// Issue #56 - the privacy "Back" link must be context-aware so users who arrive
// from signup or Settings are returned to where they came from, not the Landing page.
// The pure routing logic is unit-tested in ../lib/privacyNav.test.js; this verifies
// the rendered link wires that target through to an href.

afterEach(cleanup)

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Privacy />
    </MemoryRouter>,
  )
}

describe('Privacy back link', () => {
  test('points to the signup tab when from=signup', () => {
    renderAt('/privacy?from=signup')
    expect(screen.getByRole('link', { name: /back to sign up/i })).toHaveAttribute('href', '/login?tab=signup')
  })

  test('points to Settings when from=settings', () => {
    renderAt('/privacy?from=settings')
    expect(screen.getByRole('link', { name: /back to settings/i })).toHaveAttribute('href', '/settings')
  })

  test('points to Landing on a direct visit', () => {
    renderAt('/privacy')
    expect(screen.getByRole('link', { name: /back to boilerindy/i })).toHaveAttribute('href', '/')
  })
})

// Issue #193 - Contact points at the public deletion page the Play Data Safety
// form links to.
describe('Privacy contact', () => {
  test('links to the delete account page', () => {
    renderAt('/privacy')
    expect(screen.getByRole('link', { name: 'How to delete your account' })).toHaveAttribute('href', '/delete-account')
  })
})

// Issue #365 - only email and Google sign-in are enabled, so the policy must
// not list providers the app does not offer.
describe('Privacy sign-in providers', () => {
  test('names Google and no provider the app does not offer', () => {
    const { container } = renderAt('/privacy')
    const text = container.textContent || ''
    expect(text).toMatch(/a sign-in provider such as Google/)
    expect(text).not.toMatch(/Apple, GitHub|GitHub, or Discord|Google\/Apple/)
  })
})

// Issue #367 - every page was titled just "BoilerIndy". A page now renders its
// own <title>, which React 19 places ahead of index.html's static one and
// removes when the page unmounts, so the static title comes back.
describe('Privacy title', () => {
  test('titles the tab ahead of the static title and gives it back on unmount', () => {
    const fallback = document.createElement('title')
    fallback.textContent = 'BoilerIndy - campus app for Purdue Indianapolis students'
    document.head.appendChild(fallback)
    try {
      const { unmount } = renderAt('/privacy')
      expect(document.title).toBe('Privacy policy - BoilerIndy')
      unmount()
      expect(document.title).toBe('BoilerIndy - campus app for Purdue Indianapolis students')
    } finally {
      fallback.remove()
    }
  })
})
