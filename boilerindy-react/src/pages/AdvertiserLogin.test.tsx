import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import AdvertiserLogin from './AdvertiserLogin'

// Navigation bugs on the advertiser sign-in page:
// - Signing in pushed the dashboard on top of this page, so Back flashed the
//   form, bounced to the dashboard again, and took two presses to leave.
// - An advertiser whose session ended is sent here with
//   ?message=session-expired, and the page says so (by fixed key only).
// - A signed-in student who opened the portal from the account menu got
//   "Back to site" and the brand pointing at the marketing landing page.

vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))

type AuthState = { user: null | { id: string } }
const auth = vi.hoisted(() => ({ value: { user: null } as AuthState }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.value }))

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// The advertiser API as the server answers it: signed out on /me, and a
// sign-in that either succeeds or answers the wrong-password 401.
function stubAdvertiserApi({ passwordOk }: { passwordOk: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/advertiser/me') return jsonResponse(200, { authenticated: false, advertiser: null })
      if (url === '/api/advertiser/sign-in') {
        return passwordOk
          ? jsonResponse(200, { session: { advertiser: { id: 'adv-1', companyName: 'Cafe' } } })
          : jsonResponse(401, { error: { message: 'Invalid email or password.', status: 401 } })
      }
      return jsonResponse(404, { error: { message: 'Not found', status: 404 } })
    }),
  )
}

function Where() {
  const { pathname, search } = useLocation()
  const type = useNavigationType()
  return (
    <p data-testid="where" data-navigation={type}>
      {pathname + search}
    </p>
  )
}

function HistoryBack() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(-1)}>
      History back
    </button>
  )
}

// Opened from the landing page, so one Back should return to "/".
function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={['/', entry]} initialIndex={1} useTransitions={false}>
      <Routes>
        <Route path="/" element={<p>Landing</p>} />
        <Route path="/advertise" element={<AdvertiserLogin />} />
        <Route path="/advertise/dashboard" element={<p>Advertiser dashboard</p>} />
      </Routes>
      <Where />
      <HistoryBack />
    </MemoryRouter>,
  )
}

function signIn() {
  fireEvent.change(screen.getByLabelText('Business email'), { target: { value: 'ads@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in to portal' }))
}

let replace: ReturnType<typeof vi.fn>

beforeEach(() => {
  auth.value = { user: null }
  replace = vi.fn()
  vi.stubGlobal('location', { ...window.location, pathname: '/advertise', replace })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AdvertiserLogin sign-in', () => {
  test('replaces the sign-in entry with the dashboard, so one Back leaves the portal', async () => {
    stubAdvertiserApi({ passwordOk: true })
    renderAt('/advertise')
    signIn()

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/advertise/dashboard'))
    expect(screen.getByTestId('where')).toHaveAttribute('data-navigation', 'REPLACE')

    fireEvent.click(screen.getByRole('button', { name: 'History back' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/)
  })

  test('a wrong password shows its error on the form instead of redirecting', async () => {
    stubAdvertiserApi({ passwordOk: false })
    renderAt('/advertise')
    signIn()

    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/advertise')
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('AdvertiserLogin session-expired notice', () => {
  test('?message=session-expired says the session ended', () => {
    stubAdvertiserApi({ passwordOk: true })
    renderAt('/advertise?message=session-expired')

    expect(screen.getByRole('status')).toHaveTextContent('Your advertiser session expired. Please sign in again.')
  })

  test('any other ?message= shows nothing', () => {
    stubAdvertiserApi({ passwordOk: true })
    renderAt('/advertise?message=Your%20account%20is%20locked')

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/account is locked/)).toBeNull()
  })
})

describe('AdvertiserLogin way back to the site', () => {
  test('a visitor goes back to the landing page', () => {
    stubAdvertiserApi({ passwordOk: true })
    renderAt('/advertise')

    expect(screen.getByRole('link', { name: 'Back to site' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'BoilerIndy' })).toHaveAttribute('href', '/')
  })

  test('a signed-in student goes back to the app', () => {
    auth.value = { user: { id: 'user-1' } }
    stubAdvertiserApi({ passwordOk: true })
    renderAt('/advertise')

    expect(screen.getByRole('link', { name: 'Back to site' })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('link', { name: 'BoilerIndy' })).toHaveAttribute('href', '/dashboard')
  })
})

// The only h1 sat in the brand panel, which is hidden below lg, so phones and
// tablets had no h1; the form title was an h2.
describe('AdvertiserLogin headings', () => {
  test('the form title is the one h1', () => {
    stubAdvertiserApi({ passwordOk: true })
    renderAt('/advertise')

    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent('Advertiser sign in')
  })
})
