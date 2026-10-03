import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppLayout from './AppLayout'

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

function renderLayout(value: typeof auth.value) {
  auth.value = value
  return render(
    <MemoryRouter initialEntries={['/events']}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/events" element={<p>page outlet</p>} />
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
  })

  test('signed in: navigation, rails and assistant render', () => {
    renderLayout({ loading: false, user: { id: 'user-1' } })
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('spotlight-rail')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'BoilerIndy' })).toBeInTheDocument()
  })
})
