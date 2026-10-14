import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Install from './Install'

// The back link used to say "Back to sign in" (to /login) to everyone. The page
// is also opened from the landing footer and from Settings' push card, so it
// now takes its target from ?from= like the legal pages.

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }))

vi.mock('../context/AuthContext', () => ({ useAuth: mocks.useAuth }))

afterEach(cleanup)

beforeEach(() => {
  mocks.useAuth.mockReset()
  mocks.useAuth.mockReturnValue({ user: null, loading: false })
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Install />
    </MemoryRouter>,
  )
}

describe('Install back link', () => {
  test('returns to the sign-in form when opened from it', () => {
    renderAt('/install?from=signin')
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute('href', '/login')
  })

  test('returns to Settings when opened from the push notifications card', () => {
    mocks.useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false })
    renderAt('/install?from=settings')
    expect(screen.getByRole('link', { name: /back to settings/i })).toHaveAttribute('href', '/settings')
  })

  test('returns a visitor with no origin (the landing footer) to Landing', () => {
    renderAt('/install')
    expect(screen.getByRole('link', { name: /back to boilerindy/i })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('link', { name: /back to sign in/i })).toBeNull()
  })

  test('returns a signed-in student with no origin to the dashboard', () => {
    mocks.useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false })
    renderAt('/install')
    expect(screen.getByRole('link', { name: /back to boilerindy/i })).toHaveAttribute('href', '/dashboard')
  })

  test('the footer links pass the origin on', () => {
    renderAt('/install?from=signin')
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy?from=signin')
  })
})

// Issue #221 - the page renders outside AppLayout and PublicLayout, so it
// carries its own skip link, as the first stop, and main landmark.
describe('Install skip link', () => {
  test('the first link skips to the main landmark', () => {
    renderAt('/install')
    expect(screen.getAllByRole('link')[0]).toHaveAccessibleName('Skip to main content')
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', '#main')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main')
  })
})
