import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Privacy from './Privacy'

// Issue #56 - the privacy "Back" link must be context-aware so users who arrive
// from signup or Settings are returned to where they came from, not the Landing page.
// The pure routing logic is unit-tested in ../lib/privacyNav.test.js; this verifies
// the rendered link wires that target through to an href.

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }))

vi.mock('../context/AuthContext', () => ({ useAuth: mocks.useAuth }))

afterEach(cleanup)

beforeEach(() => {
  mocks.useAuth.mockReset()
  mocks.useAuth.mockReturnValue({ user: null, loading: false })
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} useTransitions={false}>
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

  // The app footer's Privacy link carries no `from`, and "/" is the signed-out
  // marketing page, so a signed-in student goes back to the dashboard.
  test('points a signed-in student with no origin to the dashboard', () => {
    mocks.useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false })
    renderAt('/privacy')
    expect(screen.getByRole('link', { name: /back to boilerindy/i })).toHaveAttribute('href', '/dashboard')
  })
})

// Issue #30 - the campus events ingest can send public event listings to
// TypeSafe's Jev, so TypeSafe is named among the service providers, with what
// it receives.
describe('Privacy service providers', () => {
  test('name TypeSafe and say that nothing about the student goes to it', () => {
    renderAt('/privacy')
    const providers = screen.getByText(/We rely on a few service providers/)
    expect(providers.textContent).toMatch(/TypeSafe \(which\s+reads the public campus event listings/)
    expect(providers.textContent).toMatch(/nothing about you is sent to it/)
  })
})

// Issue #16 - following a club stores the clubs with the account, so the
// policy says where they are kept and that deleting the account deletes them.
describe('Privacy followed clubs', () => {
  test('say the clubs a student follows are stored with the account and deleted with it', () => {
    renderAt('/privacy')
    expect(screen.getByRole('heading', { name: 'Clubs you follow' })).toBeInTheDocument()
    const body = screen.getByText(/The clubs you follow on the Clubs page/).textContent || ''
    expect(body).toMatch(/are stored with your account/)
    expect(body).toMatch(/they are deleted with your account/)
  })
})

// Issue #193 - Contact points at the public deletion page the Play Data Safety
// form links to.
describe('Privacy contact', () => {
  test('links to the delete account page', () => {
    renderAt('/privacy')
    expect(screen.getByRole('link', { name: 'How to delete your account' })).toHaveAttribute('href', '/delete-account')
  })

  // Settings -> Privacy -> Delete account used to drop the origin, so the
  // second page offered "Back to BoilerIndy" instead of "Back to Settings".
  test('passes the origin on to the delete account page and the footer links', () => {
    renderAt('/privacy?from=settings')
    expect(screen.getByRole('link', { name: 'How to delete your account' })).toHaveAttribute(
      'href',
      '/delete-account?from=settings',
    )
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms?from=settings')
    expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support?from=settings')
  })
})

// Issue #221 - the page renders outside AppLayout and PublicLayout, so it
// carries its own skip link, as the first stop, and main landmark.
describe('Privacy skip link', () => {
  test('the first link skips to the main landmark', () => {
    renderAt('/privacy')
    expect(screen.getAllByRole('link')[0]).toHaveAccessibleName('Skip to main content')
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', '#main')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main')
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1')
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

// The sign-up source (docs/analytics.md): a tagged link's ?ref= is kept in the
// tab and saved with an account created there, so the policy says what is
// kept, where, for how long, and that it is not a tracker.
describe('Privacy sign-up links', () => {
  test('say what the tag is, where it is kept and when it is saved', () => {
    renderAt('/privacy')
    expect(screen.getByRole('heading', { name: 'Sign-up links' })).toBeInTheDocument()
    const body = screen.getByText(/share links that end in a short tag/).textContent || ''
    expect(body).toMatch(/\?ref=flyer-a/)
    expect(body).toMatch(/this browser tab keeps the tag until you close the tab/)
    expect(body).toMatch(/we save the tag with your new account, once/)
    expect(body).toMatch(/signing in to an account you already\s+have saves nothing/)
    expect(body).toMatch(/It is not a cookie/)
    expect(body).toMatch(/never shared or used for advertising/)
    expect(body).toMatch(/deleted with your account/)
  })
})
