import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import SessionExpiryWatcher from './SessionExpiryWatcher'
import UpdateToast from './UpdateToast'
import type { RegistrationLike } from '../lib/swUpdate'

// "Sign in again" was a link to /login while the context still held the
// expired session, so Login saw a user and sent the student straight back to
// the page under the same alert. It now re-reads the session first and only
// goes to the sign-in form (with Login's 'session-expired' key) once the
// context is cleared.

type Session = { expiresAt: string; user: { id: string } } | null

// The context's session, as a tiny store the mocked useAuth subscribes to, so
// refreshSession can change it the way AuthContext's does.
const store = vi.hoisted(() => {
  let session: Session = null
  const listeners = new Set<() => void>()
  return {
    get: () => session,
    set: (next: Session) => {
      session = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
})
const refreshSession = vi.hoisted(() => vi.fn())

vi.mock('../context/AuthContext', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useAuth: () => ({
      session: useSyncExternalStore(store.subscribe, store.get),
      establishSession: vi.fn(),
      refreshSession,
    }),
  }
})

const sessionEnding = (msFromNow: number): Session => ({
  expiresAt: new Date(Date.now() + msFromNow).toISOString(),
  user: { id: 'user-1' },
})

function Where() {
  const { pathname, search } = useLocation()
  return <p data-testid="where">{pathname + search}</p>
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
      <SessionExpiryWatcher />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  store.set(sessionEnding(-2 * 60 * 1000))
})

afterEach(() => {
  cleanup()
  refreshSession.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SessionExpiryWatcher: Sign in again', () => {
  test('goes to the sign-in form with the session-expired key once the session is really gone', async () => {
    refreshSession.mockImplementation(async () => {
      store.set(null)
      return null
    })
    renderAt('/schedule?view=week')
    expect(screen.getByRole('alert')).toHaveTextContent('Your session has expired')

    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))

    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(
        '/login?next=%2Fschedule%3Fview%3Dweek&message=session-expired',
      ),
    )
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('clears the alert and stays put when the server still has the session', async () => {
    refreshSession.mockImplementation(async () => {
      const fresh = sessionEnding(30 * 24 * 60 * 60 * 1000)
      store.set(fresh)
      return fresh
    })
    renderAt('/schedule')

    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/schedule$/)
  })
})

// The warning sat 80px up at z-[3000]: on phones it covered the assistant
// button (76px up), and it covered the open panel's input row.
describe('SessionExpiryWatcher: placement', () => {
  test('clears the assistant button on phones and layers under the open assistant panel', () => {
    store.set(sessionEnding(5 * 60 * 1000))
    renderAt('/schedule')

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Your session expires in about 5 min')
    // UpdateToast's phone offset, which clears the button for the same reason,
    // plus the toast's lift, which is 0px while no toast shows.
    expect(alert).toHaveClass(
      'bottom-[calc(env(safe-area-inset-bottom,0px)+140px+var(--update-toast-lift,0px))]',
      'md:bottom-[calc(1.5rem+var(--update-toast-lift,0px))]',
    )
    // Above the assistant's backdrop (z-40), under its panel (z-50).
    expect(alert).toHaveClass('z-[45]')
  })

  // UpdateToast shares the slot at z-[1200], so it covered the warning's
  // buttons. While it shows, the warning's offset grows by its height and a gap.
  test('stacks above the update toast while the toast shows', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 58 } as DOMRect)
    let announce: ((r: RegistrationLike) => void) | null = null
    const register = async ({ onUpdateReady }: { onUpdateReady: (r: RegistrationLike) => void }) => {
      announce = onUpdateReady
      return null
    }
    store.set(sessionEnding(5 * 60 * 1000))
    render(
      <MemoryRouter initialEntries={['/schedule']}>
        <SessionExpiryWatcher />
        <UpdateToast enabled register={register} apply={() => {}} />
      </MemoryRouter>,
    )
    const lift = () => document.documentElement.style.getPropertyValue('--update-toast-lift')
    expect(lift()).toBe('')

    await act(async () => {
      announce!({ waiting: null, installing: null, addEventListener() {}, update: async () => {} } as RegistrationLike)
    })
    expect(screen.getByTestId('sw-update-toast')).toBeInTheDocument()
    expect(lift()).toBe('66px')

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(lift()).toBe('')
    // The warning stayed usable the whole time.
    expect(screen.getByRole('button', { name: 'Stay signed in' })).toBeEnabled()
  })
})
