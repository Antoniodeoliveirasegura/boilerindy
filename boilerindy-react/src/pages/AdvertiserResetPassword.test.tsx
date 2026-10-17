import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom'
import AdvertiserResetPassword from './AdvertiserResetPassword'

// After a successful reset the page sends the advertiser to sign in after
// 2.5 s. The timer was never cleared, so a visitor who had already left (to
// Terms, Support or the brand link) was pulled back to /advertise, losing
// their forward history. It also pushed, leaving the spent link's page in
// history.

vi.mock('../lib/advertiserApi', () => ({ resetAdvertiserPassword: vi.fn().mockResolvedValue({ ok: true }) }))

function Where() {
  const { pathname } = useLocation()
  const type = useNavigationType()
  return (
    <p data-testid="where" data-navigation={type}>
      {pathname}
    </p>
  )
}

function renderResetPage() {
  return render(
    <MemoryRouter initialEntries={['/advertise/reset-password?token=reset-token']} useTransitions={false}>
      <Routes>
        <Route path="/advertise/reset-password" element={<AdvertiserResetPassword />} />
        <Route path="/advertise" element={<p>Advertiser sign in</p>} />
        <Route path="/terms" element={<p>Terms of Service</p>} />
      </Routes>
      {/* Stands in for the footer's Terms link, which lives outside the page. */}
      <Link to="/terms">Terms</Link>
      <Where />
    </MemoryRouter>,
  )
}

async function resetPassword() {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-1' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'new-password-1' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))
  })
  expect(screen.getByText(/Your password has been reset/)).toBeInTheDocument()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AdvertiserResetPassword redirect', () => {
  test('a visitor who stays is sent to sign in, replacing the spent link', async () => {
    renderResetPage()
    await resetPassword()

    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(screen.getByTestId('where')).toHaveTextContent('/advertise')
    expect(screen.getByTestId('where')).toHaveAttribute('data-navigation', 'REPLACE')
  })

  test('leaving the page within 2.5 s cancels the redirect', async () => {
    renderResetPage()
    await resetPassword()

    fireEvent.click(screen.getByRole('link', { name: 'Terms' }))
    expect(screen.getByText('Terms of Service')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByTestId('where')).toHaveTextContent('/terms')
    expect(screen.getByText('Terms of Service')).toBeInTheDocument()
  })
})
