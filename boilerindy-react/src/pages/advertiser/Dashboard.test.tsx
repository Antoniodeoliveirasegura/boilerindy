import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import AdvertiserDashboard from './Dashboard'

// Navigation bugs on the advertiser dashboard:
// - Sign-out pushed /advertise, leaving a signed-out dashboard entry behind,
//   so Back showed the sign-in page twice before leaving the portal.
// - A failed sign-out was swallowed and the page left anyway; the live
//   session bounced the advertiser straight back here with no message.
// - A 401 after the session ended left "You must sign in" over a false
//   "No campaigns yet" instead of going back to the sign-in page.
// - Going back to the sign-in page on a 401 from a save reloaded the page and
//   threw away the campaign form the advertiser had just filled in.
// - A failed sign-out showed its error above the screen once the list was
//   scrolled, and the button gave no sign that anything was happening.

vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type SignOutAnswer = 'ok' | 'server-error' | 'offline' | 'pending'

const SIGNED_OUT_401 = { error: { message: 'You must sign in to the advertiser portal.', status: 401 } }
const DRAFT = { id: 'cmp-1', name: 'Fall coffee promo', placement: 'side-rail', status: 'draft', creative: {} }

function stubAdvertiserApi({
  campaigns = 200,
  list = [],
  writes = 200,
  signOut = 'ok',
}: {
  campaigns?: 200 | 401
  list?: unknown[]
  writes?: 200 | 401
  signOut?: SignOutAnswer
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url.startsWith('/api/advertiser/campaigns') && method !== 'GET') {
      return writes === 200 ? jsonResponse(200, { campaign: DRAFT }) : jsonResponse(401, SIGNED_OUT_401)
    }
    if (url === '/api/advertiser/campaigns') {
      return campaigns === 200 ? jsonResponse(200, { campaigns: list }) : jsonResponse(401, SIGNED_OUT_401)
    }
    if (url === '/api/advertiser/sign-out') {
      if (signOut === 'pending') return new Promise<Response>(() => {})
      if (signOut === 'offline') throw new TypeError('Failed to fetch')
      return signOut === 'ok'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(500, { error: { message: 'Internal server error', status: 500 } })
    }
    return jsonResponse(404, { error: { message: 'Not found', status: 404 } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
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

// Reached from the landing page, so one Back after signing out returns to "/".
function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/', '/advertise/dashboard']} initialIndex={1}>
      <Routes>
        <Route path="/" element={<p>Landing</p>} />
        <Route path="/advertise" element={<p>Advertiser sign in</p>} />
        <Route path="/advertise/dashboard" element={<AdvertiserDashboard advertiser={{ companyName: 'Corner Cafe' }} />} />
      </Routes>
      <Where />
      <HistoryBack />
    </MemoryRouter>,
  )
}

let replace: ReturnType<typeof vi.fn>

beforeEach(() => {
  replace = vi.fn()
  vi.stubGlobal('location', { ...window.location, pathname: '/advertise/dashboard', replace })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AdvertiserDashboard sign-out', () => {
  test('replaces the dashboard with the sign-in page, so one Back leaves the portal', async () => {
    stubAdvertiserApi({ signOut: 'ok' })
    renderDashboard()
    await screen.findByText('No campaigns yet')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/advertise'))
    expect(screen.getByTestId('where')).toHaveAttribute('data-navigation', 'REPLACE')

    fireEvent.click(screen.getByRole('button', { name: 'History back' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/)
  })

  test.each<[SignOutAnswer]>([['server-error'], ['offline']])(
    'stays on the dashboard and says so beside the button when sign-out fails (%s)',
    async (signOut) => {
      const fetchMock = stubAdvertiserApi({ signOut })
      renderDashboard()
      await screen.findByText('No campaigns yet')

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Sign-out failed, so you are still signed in. Please try again.')
      // In the sticky header, so it shows however far the list is scrolled.
      expect(alert.closest('header')).not.toBeNull()
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
      expect(fetchMock).toHaveBeenCalledWith('/api/advertiser/sign-out', expect.anything())
      expect(screen.getByTestId('where')).toHaveTextContent('/advertise/dashboard')
    },
  )

  test('disables the button while the sign-out request is in flight', async () => {
    stubAdvertiserApi({ signOut: 'pending' })
    renderDashboard()
    await screen.findByText('No campaigns yet')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('button', { name: 'Signing out…' })).toBeDisabled()
  })
})

describe('AdvertiserDashboard after the session ends', () => {
  test('a 401 on the campaign list goes back to sign in instead of a false empty state', async () => {
    stubAdvertiserApi({ campaigns: 401 })
    renderDashboard()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/advertise?message=session-expired'))
    expect(screen.queryByText('No campaigns yet')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('AdvertiserDashboard: a save after the session ends', () => {
  test('creating keeps the form and what was typed, and offers sign-in in a new tab', async () => {
    stubAdvertiserApi({ writes: 401 })
    renderDashboard()
    await screen.findByText('No campaigns yet')

    fireEvent.click(screen.getAllByRole('button', { name: 'New campaign' })[0])
    fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: 'Spring sale' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create campaign' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your advertiser session ended, so this was not saved.')
    const link = screen.getByRole('link', { name: 'Sign in again in a new tab' })
    expect(link).toHaveAttribute('href', '/advertise?message=session-expired')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByLabelText('Campaign name')).toHaveValue('Spring sale')
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent('/advertise/dashboard')
  })

  test('saving an edit keeps the form and what was typed', async () => {
    stubAdvertiserApi({ list: [DRAFT], writes: 401 })
    renderDashboard()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: 'Winter coffee promo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your advertiser session ended, so this was not saved.')
    expect(screen.getByLabelText('Campaign name')).toHaveValue('Winter coffee promo')
    expect(replace).not.toHaveBeenCalled()
  })

  test('a status change with no form open goes back to sign in', async () => {
    stubAdvertiserApi({ list: [DRAFT], writes: 401 })
    renderDashboard()

    fireEvent.click(await screen.findByRole('button', { name: 'Submit for review' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/advertise?message=session-expired'))
  })

  test('a status change with a form open keeps the form instead', async () => {
    stubAdvertiserApi({ list: [DRAFT], writes: 401 })
    renderDashboard()

    fireEvent.click(await screen.findByRole('button', { name: 'New campaign' }))
    fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: 'Spring sale' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your advertiser session ended')
    expect(screen.getByLabelText('Campaign name')).toHaveValue('Spring sale')
    expect(replace).not.toHaveBeenCalled()
  })
})
