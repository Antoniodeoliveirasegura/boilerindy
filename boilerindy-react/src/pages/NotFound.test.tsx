import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import PublicLayout from '../components/PublicLayout'
import NotFound from './NotFound'

// Issues #245 and #222 - an unknown URL rendered a blank page because the
// router had no catch-all. NotFound now sits as the last child of the
// PublicLayout group in App.tsx; this mirrors that shape (a top-level route,
// the PublicLayout group, and a second layout group) so it also pins that the
// catch-all only answers paths nothing else matches.

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

vi.mock('../context/AuthContext', () => ({ useAuth: mocks.useAuth }))
vi.mock('@sentry/react', () => ({ addBreadcrumb: mocks.addBreadcrumb }))

afterEach(cleanup)

beforeEach(() => {
  mocks.useAuth.mockReset()
  mocks.addBreadcrumb.mockReset()
  mocks.useAuth.mockReturnValue({ user: null, loading: false })
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div data-testid="page">login</div>} />
        <Route element={<PublicLayout />}>
          <Route path="/reset-password" element={<div data-testid="page">reset</div>} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route
          element={
            <div data-testid="app-layout">
              <Outlet />
            </div>
          }
        >
          <Route path="/dashboard" element={<div data-testid="page">dashboard</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('NotFound', () => {
  test('renders at an unknown path with the disclaimer and a sign-in link when signed out', () => {
    renderAt('/nope')
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByText('That link is wrong or the page moved.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(screen.queryByRole('link', { name: 'Go to your dashboard' })).not.toBeInTheDocument()
    expect(screen.getByText(/not affiliated with/i)).toBeInTheDocument()
  })

  test('links a signed-in visitor to the dashboard instead of sign in', () => {
    mocks.useAuth.mockReturnValue({ user: { id: 'u1' }, loading: false })
    renderAt('/some/unknown/page')
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to your dashboard' })).toHaveAttribute('href', '/dashboard')
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.getByText(/not affiliated with/i)).toBeInTheDocument()
  })

  test('holds the second link while the session is still loading', () => {
    mocks.useAuth.mockReturnValue({ user: null, loading: true })
    renderAt('/nope')
    expect(screen.getByRole('link', { name: 'Go to the home page' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Go to your dashboard' })).not.toBeInTheDocument()
  })

  test('leaves a navigation breadcrumb with the missed path, not an error', () => {
    renderAt('/old/link?x=1')
    expect(mocks.addBreadcrumb).toHaveBeenCalledWith({
      category: 'navigation',
      message: 'not-found',
      data: { path: '/old/link' },
    })
  })

  test.each([
    ['/login', 'login'],
    ['/reset-password', 'reset'],
    ['/dashboard', 'dashboard'],
  ])('does not swallow the known route %s', (path, text) => {
    renderAt(path)
    expect(screen.getByTestId('page')).toHaveTextContent(text)
    expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument()
    expect(mocks.addBreadcrumb).not.toHaveBeenCalled()
  })
})
