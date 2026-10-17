import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import DeleteAccount from './DeleteAccount'

// Issue #193 - Google Play's Data Safety form links to this page, so it has to
// explain both deletion paths and carry a working email fallback for people
// who no longer have the app.

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
      <DeleteAccount />
    </MemoryRouter>,
  )
}

describe('DeleteAccount page', () => {
  test('covers the in-app path, the email fallback and what is kept', () => {
    renderAt('/delete-account')
    expect(screen.getByRole('heading', { level: 1, name: 'Delete your account' })).toBeInTheDocument()
    for (const name of ['Delete from the app', 'Delete by email', 'What gets deleted', 'What we keep']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
    }
  })

  test('the email link opens a deletion request to privacy@', () => {
    renderAt('/delete-account')
    expect(screen.getByRole('link', { name: 'privacy@boilerindy.app' })).toHaveAttribute(
      'href',
      'mailto:privacy@boilerindy.app?subject=Delete%20my%20BoilerIndy%20account',
    )
  })

  test('links to Settings, the privacy policy and support', () => {
    renderAt('/delete-account')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy')
    expect(screen.getByRole('link', { name: 'support page' })).toHaveAttribute('href', '/support')
  })

  test('the back link honours ?from=settings', () => {
    renderAt('/delete-account?from=settings')
    expect(screen.getByRole('link', { name: /back to settings/i })).toHaveAttribute('href', '/settings')
  })

  // These links used to drop the origin, so the next page's back link
  // forgot where the reader started.
  test('passes the origin on to the privacy policy and support', () => {
    renderAt('/delete-account?from=settings')
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy?from=settings')
    expect(screen.getByRole('link', { name: 'support page' })).toHaveAttribute('href', '/support?from=settings')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })

  test('the back link sends a visitor with no origin to Landing', () => {
    renderAt('/delete-account')
    expect(screen.getByRole('link', { name: /back to boilerindy/i })).toHaveAttribute('href', '/')
  })

  // A signed-in student with no origin goes back into the app, not to the
  // signed-out marketing page.
  test('the back link sends a signed-in student with no origin to the dashboard', () => {
    mocks.useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false })
    renderAt('/delete-account')
    expect(screen.getByRole('link', { name: /back to boilerindy/i })).toHaveAttribute('href', '/dashboard')
  })

  // Issue #221 - the page renders outside AppLayout and PublicLayout, so it
  // carries its own skip link, as the first stop, and main landmark.
  test('the first link skips to the main landmark', () => {
    renderAt('/delete-account')
    expect(screen.getAllByRole('link')[0]).toHaveAccessibleName('Skip to main content')
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', '#main')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main')
  })
})

// Issue #365 - only email and Google sign-in are enabled.
describe('DeleteAccount sign-in providers', () => {
  test('tells provider sign-ups without a password to confirm with Google, naming only Google', () => {
    const { container } = renderAt('/delete-account')
    const text = container.textContent || ''
    expect(text).toMatch(/signed up with a sign-in provider such as Google and never set a password, choose Confirm with Google/)
    expect(text).not.toMatch(/Apple|GitHub|Discord/)
  })
})
