import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import AuthCallback from './AuthCallback'
import { startGoogleConfirm } from '../lib/googleConfirm'
import { supabase } from '../lib/supabase'

// The callback page showed ?error_description verbatim, so anyone could link a
// student to their own words ("Your account is locked. Call ...") on the
// BoilerIndy domain. It had no live region and no heading either.

const auth = vi.hoisted(() => ({
  establishSession: vi.fn(() => Promise.resolve(null)),
  refreshSession: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      exchangeCodeForSession: vi.fn(async () => ({ error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  },
}))

function Where() {
  const { pathname, search } = useLocation()
  return <p data-testid="where">{pathname + search}</p>
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]} useTransitions={false}>
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

// Google can return any account signed in to the browser. Picking another one
// during Confirm with Google switched this browser to that account, or created
// it; the server now refuses it, and the callback drops its Supabase session.
describe('AuthCallback after Confirm with Google', () => {
  const returnedAs = (email: string) => ({ data: { session: { user: { email } } }, error: null }) as never

  beforeEach(() => {
    sessionStorage.clear()
    auth.establishSession.mockClear()
    auth.refreshSession.mockClear()
    vi.mocked(supabase.auth.signOut).mockClear()
  })

  afterEach(() => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null } as never)
  })

  test('drops another account that comes back and returns to Settings as the same student', async () => {
    startGoogleConfirm('Student@Example.edu', true)
    sessionStorage.setItem('postAuthNext', '/settings?confirmed=google&for=delete')
    vi.mocked(supabase.auth.getSession).mockResolvedValue(returnedAs('someone.else@gmail.com'))
    renderAt('/auth/callback?code=abc')
    await act(async () => {})

    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(auth.refreshSession).toHaveBeenCalled()
    expect(auth.establishSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent('/settings?confirm=wrong-account&for=delete')
    expect(sessionStorage.length).toBe(0)
  })

  test('carries on to Settings when the same account comes back', async () => {
    startGoogleConfirm('student@example.edu', false)
    sessionStorage.setItem('postAuthNext', '/settings?confirmed=google')
    vi.mocked(supabase.auth.getSession).mockResolvedValue(returnedAs('Student@example.edu'))
    renderAt('/auth/callback?code=abc')
    await act(async () => {})

    expect(supabase.auth.signOut).not.toHaveBeenCalled()
    expect(auth.establishSession).toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent('/settings?confirmed=google')
  })

  test('never checks a plain Google sign-in', async () => {
    sessionStorage.setItem('postAuthNext', '/dashboard')
    vi.mocked(supabase.auth.getSession).mockResolvedValue(returnedAs('someone.else@gmail.com'))
    renderAt('/auth/callback?code=abc')
    await act(async () => {})

    expect(supabase.auth.signOut).not.toHaveBeenCalled()
    expect(auth.establishSession).toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard')
  })

  test('forgets the confirmation when Google returns an error', async () => {
    startGoogleConfirm('student@example.edu', false)
    renderAt('/auth/callback?error=access_denied')
    await act(async () => {})

    expect(sessionStorage.getItem('googleConfirm')).toBeNull()
  })
})
