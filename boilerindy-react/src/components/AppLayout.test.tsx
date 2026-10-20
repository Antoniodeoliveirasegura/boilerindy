import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppLayout from './AppLayout'
import { PREVIEW_MESSAGE, previewMessage } from '../lib/publicPreview'

// Issue #369: AppLayout rendered the navbar, bottom tab bar, spotlight rails
// and assistant while auth was still loading, so a signed-out visitor saw the
// signed-in app before RequireAuth sent them to /login. The chrome now waits
// for a user; the outlet (with RequireAuth's "Loading…") renders either way.

const auth = vi.hoisted(() => ({
  value: { loading: true, user: null as null | { id: string } },
}))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    ...auth.value,
    session: null,
    establishSession: vi.fn(),
    getFirstName: () => 'Pete',
    getInitials: () => 'P',
    getDisplayName: () => 'Pete',
  }),
  useSignOutAndRedirect: () => vi.fn(),
}))
vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))
vi.mock('../lib/authApi', () => ({ authRequest: vi.fn(async () => ({})) }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../lib/scheduleOverrideStore', () => ({ syncScheduleOverridesFromServer: vi.fn() }))
vi.mock('./spotlight/SideSpotlightRail', () => ({ default: () => <aside data-testid="spotlight-rail" /> }))

afterEach(cleanup)

function renderLayout(value: typeof auth.value, path = '/events') {
  auth.value = value
  return render(
    <MemoryRouter initialEntries={[path]} useTransitions={false}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/events" element={<p>page outlet</p>} />
          <Route path="/free-food" element={<p>page outlet</p>} />
          <Route path="/clubs" element={<p>page outlet</p>} />
          <Route path="/dining" element={<p>page outlet</p>} />
          <Route path="/transit" element={<p>page outlet</p>} />
          <Route path="/map" element={<p>page outlet</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('AppLayout chrome', () => {
  test('while auth loads: outlet only, no navigation, rails or assistant', () => {
    renderLayout({ loading: true, user: null })
    expect(screen.getByText('page outlet')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.queryAllByRole('navigation')).toHaveLength(0)
    expect(screen.queryByTestId('spotlight-rail')).toBeNull()
    expect(screen.queryByRole('button', { name: 'BoilerIndy' })).toBeNull()
  })

  test('signed out after loading: still no app chrome', () => {
    renderLayout({ loading: false, user: null })
    expect(screen.queryAllByRole('navigation')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'BoilerIndy' })).toBeNull()
    expect(screen.queryByTestId('preview-bar')).toBeNull()
  })

  test('signed in: navigation, rails and assistant render', () => {
    renderLayout({ loading: false, user: { id: 'user-1' } }, '/clubs')
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('spotlight-rail')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'BoilerIndy' })).toBeInTheDocument()
  })

  // Issue #30: the pages that list the shared campus events carry no sponsor
  // rails, since Ticketmaster's API terms bar revenue from its listings.
  test.each(['/events', '/free-food', '/Events/'])('signed in on %s: navigation and assistant, no sponsor rails', (path) => {
    renderLayout({ loading: false, user: { id: 'user-1' } }, path)
    expect(screen.getByText('page outlet')).toBeInTheDocument()
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('spotlight-rail')).toBeNull()
    expect(screen.getByRole('button', { name: 'BoilerIndy' })).toBeInTheDocument()
  })
})

// Issue #366: /dining, /transit, /map and /free-food render for signed-out
// visitors. They get the preview bar in the navbar's place; nothing else changes.
describe('AppLayout on a preview route', () => {
  test('signed out: the preview bar with its two links, and no app chrome', () => {
    renderLayout({ loading: false, user: null }, '/dining')
    expect(screen.getByText('page outlet')).toBeInTheDocument()
    expect(screen.getByTestId('preview-bar')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/login?tab=signup')
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=%2Fdining')
    expect(screen.getByRole('link', { name: 'BoilerIndy' })).toHaveAttribute('href', '/')
    expect(screen.queryAllByRole('navigation')).toHaveLength(0)
    expect(screen.queryByTestId('spotlight-rail')).toBeNull()
    expect(screen.queryByRole('button', { name: 'BoilerIndy' })).toBeNull()
  })

  test('signed out on transit: sign-in comes back to transit', () => {
    renderLayout({ loading: false, user: null }, '/transit')
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=%2Ftransit')
  })

  test.each(['/map', '/free-food'])('signed out on %s: the bar, its own message and sign-in back to the page, and no app chrome', (path) => {
    renderLayout({ loading: false, user: null }, path)
    expect(screen.getByText('page outlet')).toBeInTheDocument()
    const bar = screen.getByTestId('preview-bar')
    expect(bar).toHaveTextContent(previewMessage(path))
    expect(previewMessage(path)).not.toBe(PREVIEW_MESSAGE)
    // The phone card says the same.
    expect(screen.getByTestId('preview-note')).toHaveTextContent(previewMessage(path))
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/login?next=${encodeURIComponent(path)}`)
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/login?tab=signup')
    expect(screen.queryAllByRole('navigation')).toHaveLength(0)
    expect(screen.queryByTestId('spotlight-rail')).toBeNull()
    expect(screen.queryByRole('button', { name: 'BoilerIndy' })).toBeNull()
  })

  // The map fills a phone's screen and stops above the pitch card, whose
  // height the bar keeps on the root while it shows.
  test('signed out, the pitch card height is kept on the root for as long as the bar shows', () => {
    const root = document.documentElement
    const { unmount } = renderLayout({ loading: false, user: null }, '/map')
    expect(root.style.getPropertyValue('--preview-note-h')).toMatch(/^\d+px$/)
    unmount()
    expect(root.style.getPropertyValue('--preview-note-h')).toBe('')

    renderLayout({ loading: false, user: { id: 'user-1' } }, '/map')
    expect(root.style.getPropertyValue('--preview-note-h')).toBe('')
  })

  test('while auth loads: the navbar slot is held, with no bar and no navbar yet', () => {
    renderLayout({ loading: true, user: null }, '/dining')
    expect(screen.getByText('page outlet')).toBeInTheDocument()
    // The navbar's own height: 56 px on phones, 64 px from md.
    expect(screen.getByTestId('navbar-slot')).toHaveClass('h-14', 'md:h-16')
    expect(screen.queryByTestId('preview-bar')).toBeNull()
    expect(screen.queryAllByRole('navigation')).toHaveLength(0)
  })

  test('signed in: the usual navbar, no preview bar and no held slot', () => {
    renderLayout({ loading: false, user: { id: 'user-1' } }, '/transit')
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('preview-bar')).toBeNull()
    expect(screen.queryByTestId('navbar-slot')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Create account' })).toBeNull()
  })
})
