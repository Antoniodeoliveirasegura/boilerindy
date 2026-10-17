import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { useSyncExternalStore } from 'react'
import RequireAuth from './RequireAuth'

// A 503 or a dropped connection on the session read signed a validly
// signed-in student out: RequireAuth sent them to a bare sign-in form. When the
// read got no answer it now offers a retry and keeps them on the page.

type AuthState = {
  user: { id: string } | null
  loading: boolean
  sessionCheckFailed: boolean
}

// The context, as a tiny store the mocked useAuth subscribes to, so a retry
// can change it the way AuthContext's establishSession does.
const store = vi.hoisted(() => {
  let state: AuthState = { user: null, loading: false, sessionCheckFailed: false }
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (next: Partial<AuthState>) => {
      state = { ...state, ...next }
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
const establishSession = vi.hoisted(() => vi.fn())

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ ...useSyncExternalStore(store.subscribe, store.get), establishSession }),
}))

function Where() {
  const { pathname, search } = useLocation()
  return <p data-testid="where">{pathname + search}</p>
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]} useTransitions={false}>
      <Routes>
        <Route
          path="/assignments"
          element={
            <RequireAuth>
              <p>Assignments page</p>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  store.set({ user: null, loading: false, sessionCheckFailed: false })
})

afterEach(() => {
  cleanup()
  establishSession.mockReset()
})

describe('RequireAuth', () => {
  test('sends a visitor the server says is signed out to the sign-in form', () => {
    renderAt('/assignments?view=week')
    expect(screen.getByTestId('where')).toHaveTextContent('/login?next=%2Fassignments%3Fview%3Dweek')
  })

  test('offers a retry, not the sign-in form, when the session read got no answer', () => {
    store.set({ sessionCheckFailed: true })
    renderAt('/assignments')
    expect(screen.getByRole('heading', { level: 1, name: 'Can’t reach BoilerIndy right now' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByTestId('where')).toBeNull()
  })

  test('a retry that finds the session shows the page', async () => {
    store.set({ sessionCheckFailed: true })
    establishSession.mockImplementation(async () => {
      store.set({ user: { id: 'user-1' }, sessionCheckFailed: false })
      return { user: { id: 'user-1' } }
    })
    renderAt('/assignments')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(screen.getByText('Assignments page')).toBeInTheDocument())
    expect(establishSession).toHaveBeenCalledTimes(1)
  })

  test('a retry the server answers with signed out goes to the sign-in form', async () => {
    store.set({ sessionCheckFailed: true })
    establishSession.mockImplementation(async () => {
      store.set({ sessionCheckFailed: false })
      return null
    })
    renderAt('/assignments')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login?next=%2Fassignments'))
  })

  test('a retry that still gets no answer stays on the retry screen', async () => {
    store.set({ sessionCheckFailed: true })
    let finish: () => void = () => {}
    establishSession.mockImplementation(() => new Promise<null>((resolve) => (finish = () => resolve(null))))
    renderAt('/assignments')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Trying again…' })).toBeInTheDocument()
    finish()

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByTestId('where')).toBeNull()
  })
})
