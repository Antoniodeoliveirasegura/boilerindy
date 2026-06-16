import { afterEach, describe, expect, test } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Privacy from './Privacy'

// Issue #56 — the privacy "Back" link must be context-aware so users who arrive
// from signup or Settings are returned to where they came from, not the Landing page.
// The pure routing logic is unit-tested in ../lib/privacyNav.test.js; this verifies
// the rendered link wires that target through to an href.

afterEach(cleanup)

function renderAt(path) {
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
