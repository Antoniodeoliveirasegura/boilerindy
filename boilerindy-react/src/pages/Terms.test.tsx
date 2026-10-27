import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Terms from './Terms'

// Issue #193 - Contact points at the public support page the App Store support
// URL links to.

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
      <Terms />
    </MemoryRouter>,
  )
}

describe('Terms contact', () => {
  test('links to the support page', () => {
    renderAt('/terms')
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support')
  })

  // The hop to Support used to drop the origin, so Support's back link
  // forgot where the reader started.
  test('passes the origin on to the support page', () => {
    renderAt('/terms?from=signup')
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support?from=signup')
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy?from=signup')
  })
})

describe('Terms back link', () => {
  test('points a visitor with no origin to Landing', () => {
    renderAt('/terms')
    expect(screen.getByRole('link', { name: /back to boilerindy/i })).toHaveAttribute('href', '/')
  })

  // The app footer's Terms link carries no origin; "/" is the signed-out
  // marketing page.
  test('points a signed-in student with no origin to the dashboard', () => {
    mocks.useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false })
    renderAt('/terms')
    expect(screen.getByRole('link', { name: /back to boilerindy/i })).toHaveAttribute('href', '/dashboard')
  })
})

// Issue #526 - Apple asks apps with user posts for terms that rule out
// objectionable content and abusive users (guideline 1.2), students can be
// 17, and a copyright owner had no way to ask for a takedown.
describe('Terms rules (issue #526)', () => {
  const body = (heading: string) =>
    (screen.getByRole('heading', { name: heading }).closest('section') as HTMLElement).textContent || ''

  test('say there is zero tolerance for objectionable content and abusive users', () => {
    renderAt('/terms')
    const rules = body('Acceptable use')
    expect(rules).toMatch(/zero tolerance for objectionable content and\s+abusive users/)
    expect(rules).toMatch(/report posts, listings and\s+people, and block anyone/)
  })

  test('ask for a parent or guardian under 18', () => {
    renderAt('/terms')
    expect(body('Who can use BoilerIndy')).toMatch(/under 18 you need a parent or guardian's permission/)
  })

  test('give copyright owners a takedown path and a repeat-infringer rule', () => {
    renderAt('/terms')
    const copyright = body('Copyright complaints')
    expect(copyright).toContain('legal@boilerindy.app')
    expect(copyright).toMatch(/under penalty of perjury/)
    expect(copyright).toMatch(/repeatedly post content that infringes/)
  })
})

// Issue #221 - the page renders outside AppLayout and PublicLayout, so it
// carries its own skip link, as the first stop, and main landmark.
describe('Terms skip link', () => {
  test('the first link skips to the main landmark', () => {
    renderAt('/terms')
    expect(screen.getAllByRole('link')[0]).toHaveAccessibleName('Skip to main content')
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', '#main')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main')
  })
})
