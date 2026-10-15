import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import AuthCallback from './AuthCallback'

// The callback page showed ?error_description verbatim, so anyone could link a
// student to their own words ("Your account is locked. Call ...") on the
// BoilerIndy domain. It had no live region and no heading either.

const auth = vi.hoisted(() => ({ establishSession: () => Promise.resolve(null) }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      exchangeCodeForSession: vi.fn(async () => ({ error: null })),
    },
  },
}))

function Where() {
  const { pathname, search } = useLocation()
  return <p data-testid="where">{pathname + search}</p>
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AuthCallback errors', () => {
  test('shows a fixed message in an alert under a heading, never the URL text', async () => {
    renderAt('/auth/callback?error=x&error_description=Your%20account%20is%20locked.%20Call%20555-0100%20to%20unlock%20it.')
    await act(async () => {})

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Google sign-in could not be completed.')
    expect(alert).not.toHaveTextContent(/555-0100|locked/)
    expect(screen.getByRole('heading', { level: 1, name: 'Authentication failed' })).toBeInTheDocument()
    // The detail still reaches the console for debugging.
    expect(console.error).toHaveBeenCalled()
  })

  test('still sends the student to the sign-in form with the oauth-error key', async () => {
    renderAt('/auth/callback?error=access_denied')
    await act(async () => {})

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(screen.getByTestId('where')).toHaveTextContent('/login?error=oauth-error')
  })
})
