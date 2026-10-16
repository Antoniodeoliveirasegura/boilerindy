import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Support from './Support'

// Issue #193 - the App Store support URL and the published contact both stores
// require for apps with user posts.

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }))

vi.mock('../context/AuthContext', () => ({ useAuth: mocks.useAuth }))

afterEach(cleanup)

beforeEach(() => {
  mocks.useAuth.mockReset()
  mocks.useAuth.mockReturnValue({ user: null, loading: false })
})

function renderSupport(path = '/support') {
  return render(
    <MemoryRouter initialEntries={[path]} useTransitions={false}>
      <Support />
    </MemoryRouter>,
  )
}

describe('Support page', () => {
  test('shows the heading and the support email', () => {
    renderSupport()
    expect(screen.getByRole('heading', { level: 1, name: 'Support' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'support@boilerindy.app' })).toHaveAttribute(
      'href',
      'mailto:support@boilerindy.app',
    )
    expect(document.body.textContent).toMatch(/within a few days/)
  })

  test('links abuse reports, privacy requests and GitHub issues', () => {
    renderSupport()
    expect(screen.getByRole('link', { name: 'abuse@boilerindy.app' })).toHaveAttribute('href', 'mailto:abuse@boilerindy.app')
    expect(screen.getByRole('link', { name: 'privacy@boilerindy.app' })).toHaveAttribute(
      'href',
      'mailto:privacy@boilerindy.app',
    )
    expect(screen.getByRole('link', { name: 'open an issue on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/Antoniodeoliveirasegura/boilerindy/issues',
    )
  })

  test('links to the privacy policy, the terms and account deletion', () => {
    renderSupport()
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy')
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: 'Delete your account' })).toHaveAttribute('href', '/delete-account')
  })

  // These links used to drop the origin, so the next page's back link
  // forgot where the reader started.
  test('passes the origin on to the privacy policy, the terms and account deletion', () => {
    renderSupport('/support?from=settings')
    expect(screen.getByRole('link', { name: /back to settings/i })).toHaveAttribute('href', '/settings')
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy?from=settings')
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms?from=settings')
    expect(screen.getByRole('link', { name: 'Delete your account' })).toHaveAttribute(
      'href',
      '/delete-account?from=settings',
    )
  })

  // The app footer's Support link carries no origin; "/" is the signed-out
  // marketing page.
  test('the back link sends a signed-in student with no origin to the dashboard', () => {
    mocks.useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false })
    renderSupport()
    expect(screen.getByRole('link', { name: /back to boilerindy/i })).toHaveAttribute('href', '/dashboard')
  })

  // Issue #221 - the page renders outside AppLayout and PublicLayout, so it
  // carries its own skip link, as the first stop, and main landmark.
  test('the first link skips to the main landmark', () => {
    renderSupport()
    expect(screen.getAllByRole('link')[0]).toHaveAccessibleName('Skip to main content')
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', '#main')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main')
  })
})
