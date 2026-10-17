import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth, useSignOutAndRedirect } from './AuthContext'

// Issue #111 - /api/auth/supabase-sync fired twice per login: once from the
// SIGNED_IN listener and once from an explicit establishSession(). Each POST
// re-validates the JWT against Supabase before upserting the same row, so the
// duplicate is a wasted round-trip on the slowest path in the app.
//
// The fix coalesces in-flight calls sharing an access token. The tests that
// matter most are the negative ones: it must NOT behave like a cache, because
// establishSession() runs on auth events that each need a freshly validated
// session.
//
// Issue #149 - refreshSession() was split out of establishSession(). The
// mutation callers (ConnectSchedule, Settings) now re-read the session with a
// plain GET /api/session and must issue NO supabase-sync; establishSession()
// keeps the token-validating sync. The final describe block covers that split.

const mocks = vi.hoisted(() => ({
  authRequest: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
      signOut: mocks.signOut,
    },
  },
}))

vi.mock('../lib/authApi', () => ({
  authRequest: mocks.authRequest,
  getDisplayName: () => 'Example Student',
  getFirstName: () => 'Example',
  getInitials: () => 'ES',
  startPurdueLink: vi.fn(),
}))

const SYNC = '/api/auth/supabase-sync'
const SESSION = '/api/session'

function makeSupabaseSession(token: string) {
  return {
    access_token: token,
    user: {
      id: 'user-1',
      email: 'student@example.edu',
      user_metadata: {},
      app_metadata: { provider: 'email' },
    },
  }
}

const backendSession = { user: { name: 'Example Student', email: 'student@example.edu' } }

// Captured from onAuthStateChange so tests can fire SIGNED_IN like Supabase does.
let emitAuthEvent: (event: string, session: unknown) => Promise<void>

const syncCount = () => mocks.authRequest.mock.calls.filter(([path]) => path === SYNC).length
const calledWith = (path: string) => mocks.authRequest.mock.calls.some(([p]) => p === path)

// AuthProvider clears the query cache on sign-out (issue #327), so it renders
// under a query client here, as it does under the provider in main.tsx.
const queryClient = new QueryClient()
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>{children}</AuthProvider>
  </QueryClientProvider>
)

beforeEach(() => {
  vi.clearAllMocks()

  mocks.getSession.mockResolvedValue({ data: { session: makeSupabaseSession('tok-1') } })

  mocks.onAuthStateChange.mockImplementation((cb: typeof emitAuthEvent) => {
    emitAuthEvent = cb
    return { data: { subscription: { unsubscribe: vi.fn() } } }
  })

  // Resolve on a later tick so concurrent callers genuinely overlap, the way
  // they do against a real network.
  mocks.authRequest.mockImplementation(async (path: string) => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (path === SYNC) return { session: backendSession }
    if (path === SESSION) return { session: backendSession }
    if (path === '/api/auth-config') return { authProvider: 'local', purdueAuthMode: 'mock' }
    return {}
  })
})

afterEach(cleanup)

async function mountAuth() {
  const { result } = renderHook(() => useAuth(), { wrapper })
  await waitFor(() => expect(result.current.loading).toBe(false))
  mocks.authRequest.mockClear()
  return result
}

describe('supabase-sync deduplication', () => {
  test('two concurrent establishSession calls issue one sync', async () => {
    const result = await mountAuth()

    await act(async () => {
      await Promise.all([result.current.establishSession(), result.current.establishSession()])
    })

    expect(syncCount()).toBe(1)
  })

  // The actual shape of the bug: signup and the OAuth callback both land here.
  test('the SIGNED_IN listener racing establishSession issues one sync', async () => {
    const result = await mountAuth()

    await act(async () => {
      await Promise.all([
        emitAuthEvent('SIGNED_IN', makeSupabaseSession('tok-1')),
        result.current.establishSession(),
      ])
    })

    expect(syncCount()).toBe(1)
  })

  test('both concurrent callers still receive the session payload', async () => {
    const result = await mountAuth()

    let first: unknown
    let second: unknown
    await act(async () => {
      ;[first, second] = await Promise.all([
        result.current.establishSession(),
        result.current.establishSession(),
      ])
    })

    expect(first).toEqual(backendSession)
    expect(second).toEqual(backendSession)
  })

  // Guards against "fixing" this with a TTL cache. establishSession() runs on
  // auth events that each need a freshly validated session; a remembered payload
  // would resurrect a stale or superseded one.
  test('sequential establishSession calls each reach the network', async () => {
    const result = await mountAuth()

    await act(async () => {
      await result.current.establishSession()
    })
    await act(async () => {
      await result.current.establishSession()
    })

    expect(syncCount()).toBe(2)
  })

  test('concurrent syncs for different access tokens are not merged', async () => {
    await mountAuth()

    await act(async () => {
      await Promise.all([
        emitAuthEvent('SIGNED_IN', makeSupabaseSession('tok-a')),
        emitAuthEvent('SIGNED_IN', makeSupabaseSession('tok-b')),
      ])
    })

    expect(syncCount()).toBe(2)
  })

  test('a failed sync does not wedge later syncs', async () => {
    const result = await mountAuth()

    mocks.authRequest.mockImplementationOnce(async () => {
      throw new Error('backend down')
    })

    await act(async () => {
      await result.current.establishSession()
    })
    await act(async () => {
      await result.current.establishSession()
    })

    // The in-flight entry must be cleared even when the request rejects,
    // otherwise every later login would be handed the failed promise.
    expect(syncCount()).toBe(2)
    expect(result.current.session).toEqual(backendSession)
  })
})

// Issue #149: the mutation path (refreshSession) must re-read the cookie session
// with no Supabase round-trip, while the establishment path keeps the sync.
describe('refreshSession vs establishSession (issue #149)', () => {
  test('refreshSession re-reads /api/session and issues zero syncs', async () => {
    const result = await mountAuth()
    mocks.getSession.mockClear()

    await act(async () => {
      await result.current.refreshSession()
    })

    expect(calledWith(SESSION)).toBe(true)
    expect(syncCount()).toBe(0)
    // The whole point: no getSession, so no supabase-sync round-trip.
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  test('refreshSession returns the re-read session payload', async () => {
    const result = await mountAuth()

    let returned: unknown
    await act(async () => {
      returned = await result.current.refreshSession()
    })

    expect(returned).toEqual(backendSession)
  })

  test('establishSession validates the token via supabase-sync', async () => {
    const result = await mountAuth()
    mocks.getSession.mockClear()

    await act(async () => {
      await result.current.establishSession()
    })

    expect(syncCount()).toBe(1)
    expect(mocks.getSession).toHaveBeenCalled()
  })

  test('establishSession falls back to /api/session with no Supabase session', async () => {
    const result = await mountAuth()
    // e.g. a backend-only session where the client Supabase token is gone.
    mocks.getSession.mockResolvedValueOnce({ data: { session: null } })

    await act(async () => {
      await result.current.establishSession()
    })

    expect(syncCount()).toBe(0)
    expect(calledWith(SESSION)).toBe(true)
  })
})

// Issue #219: personalized AI insight caches and the unsent board draft must not
// outlive the account on a shared computer. Issue #294 adds the dashboard's
// cached location, the legacy full-precision key and the permission-prompt flag,
// which both sign-out paths clear.
describe('sign-out clears per-user caches (issues #219, #294)', () => {
  function seedCaches() {
    localStorage.setItem('ai-week-ahead-user-1-2026-09-14', '"digest"')
    localStorage.setItem('ai-assignments-user-1-priority-2026-09-14', '"rank"')
    localStorage.setItem('boilerindy-board-draft-v1-user-1', '{"title":"draft","body":""}')
    localStorage.setItem('boilerindy-task-priority-v1-user-1', '{"task-a":"high"}')
    localStorage.setItem('boilerindy-user-location-v2', '{"lat":40.424,"lon":-86.921,"ts":1789560000000}')
    localStorage.setItem('boilerindy-user-location-v1', '{"lat":40.4237054,"lon":-86.9211946}')
    localStorage.setItem('boilerindy-geo-asked-v1', '1')
  }

  beforeEach(() => localStorage.clear())

  test('signOut removes the ai-* and board draft keys', async () => {
    const result = await mountAuth()
    seedCaches()

    await act(async () => {
      await result.current.signOut()
    })

    expect(Object.keys(localStorage)).toEqual(['boilerindy-task-priority-v1-user-1'])
    expect(result.current.session).toBeNull()
  })

  // Offline, or a 502 from a cold-starting backend: the caches still go.
  test('signOut clears the caches even when POST /api/sign-out fails', async () => {
    const result = await mountAuth()
    seedCaches()
    mocks.authRequest.mockImplementationOnce(async () => {
      throw new Error('backend down')
    })

    await act(async () => {
      await expect(result.current.signOut()).rejects.toThrow('backend down')
    })

    expect(Object.keys(localStorage)).toEqual(['boilerindy-task-priority-v1-user-1'])
    // The tab lets go of the session too, so a failed sign-out never leaves
    // the account open behind the landing page.
    expect(result.current.session).toBeNull()
  })

  // SIGNED_OUT also fires without signOut() (revoked token, another tab, Login
  // clearing a stale local session). Drafts stay so they survive a re-login
  // after session expiry (issue #23).
  test('a SIGNED_OUT event removes the ai-* keys and keeps the board draft', async () => {
    const result = await mountAuth()
    seedCaches()

    await act(async () => {
      await emitAuthEvent('SIGNED_OUT', null)
    })

    expect(Object.keys(localStorage).sort()).toEqual([
      'boilerindy-board-draft-v1-user-1',
      'boilerindy-task-priority-v1-user-1',
    ])
    expect(result.current.session).toBeNull()
  })

  // The grades and the assistant conversation stayed in browser storage after
  // sign-out, readable in devtools by the next person at the computer.
  test("signOut removes the signed-in student's grades and assistant conversation", async () => {
    const result = await mountAuth()
    await act(async () => {
      result.current.applySession({ user: { id: 'user-1', name: 'Example Student' } })
    })
    seedCaches()
    localStorage.setItem('boilerindy-grades-v1-user-1', '[{"courseName":"PSY 12000","letterGrade":"D"}]')
    sessionStorage.setItem('boilerindy-assistant-history-v1-user-1', '[{"role":"user","text":"Should I drop PSY 12000?"}]')

    await act(async () => {
      await result.current.signOut()
    })

    expect(Object.keys(localStorage)).toEqual(['boilerindy-task-priority-v1-user-1'])
    expect(sessionStorage.getItem('boilerindy-assistant-history-v1-user-1')).toBeNull()
  })
})

// Sign-out leaves the signed-in page first, so RequireAuth never sends the
// student to /login?next=<that page>. When the server cannot be reached, the
// student is told the device may still be signed in instead of landing on the
// marketing page as if all went well.
describe('useSignOutAndRedirect', () => {
  const routed = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/settings']} useTransitions={false}>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  async function mountRouted() {
    const { result } = renderHook(
      () => ({ signOutAndRedirect: useSignOutAndRedirect(), location: useLocation(), auth: useAuth() }),
      { wrapper: routed },
    )
    await waitFor(() => expect(result.current.auth.loading).toBe(false))
    return result
  }

  const where = (location: { pathname: string; search: string }) => location.pathname + location.search

  test('lands on the landing page once signed out', async () => {
    const result = await mountRouted()
    await act(async () => {
      await result.current.signOutAndRedirect()
    })
    expect(where(result.current.location)).toBe('/')
    expect(result.current.auth.session).toBeNull()
  })

  test('a sign-out the server never confirmed lands on the sign-in form with a warning', async () => {
    const result = await mountRouted()
    mocks.authRequest.mockImplementation(async (path: string) => {
      if (path === '/api/sign-out') throw new Error('offline')
      return {}
    })
    await act(async () => {
      await result.current.signOutAndRedirect()
    })
    expect(where(result.current.location)).toBe('/login?error=sign-out-failed')
    expect(result.current.auth.session).toBeNull()
  })
})

// Issue #298 - when the background Supabase sign-in failed, Login called
// signOut({ scope: 'local' }) to drop a possibly stale client session. signOut()
// broadcasts SIGNED_OUT even with nothing to sign out of, and the listener took
// that as permission to drop the backend session the form had applied a few
// lines earlier, so RequireAuth bounced a valid sign-in back to /login.
describe('SIGNED_OUT and a backend-applied session (issue #298)', () => {
  test('a SIGNED_OUT leaves a session the sign-in form applied in place', async () => {
    const result = await mountAuth()

    await act(async () => {
      result.current.applySession(backendSession)
    })
    await act(async () => {
      await emitAuthEvent('SIGNED_OUT', null)
    })

    expect(result.current.session).toEqual(backendSession)
    expect(result.current.user).toEqual(backendSession.user)
    // Supabase's own half of the state still goes.
    expect(result.current.supabaseUser).toBeNull()
  })

  test('the per-user AI caches still go when the backend session stays', async () => {
    localStorage.clear()
    const result = await mountAuth()
    localStorage.setItem('ai-week-ahead-user-1-2026-09-14', '"digest"')

    await act(async () => {
      result.current.applySession(backendSession)
    })
    await act(async () => {
      await emitAuthEvent('SIGNED_OUT', null)
    })

    expect(localStorage.getItem('ai-week-ahead-user-1-2026-09-14')).toBeNull()
    expect(result.current.session).toEqual(backendSession)
  })

  // Once the client sign-in does land, Supabase owns the session again and a
  // later sign-out has to clear it.
  test('a SIGNED_IN hands the session back to Supabase, so the next SIGNED_OUT clears it', async () => {
    const result = await mountAuth()

    await act(async () => {
      result.current.applySession(backendSession)
    })
    await act(async () => {
      await emitAuthEvent('SIGNED_IN', makeSupabaseSession('tok-2'))
    })
    await act(async () => {
      await emitAuthEvent('SIGNED_OUT', null)
    })

    expect(result.current.session).toBeNull()
  })

  test('an explicit signOut clears a backend-applied session', async () => {
    const result = await mountAuth()

    await act(async () => {
      result.current.applySession(backendSession)
    })
    await act(async () => {
      await result.current.signOut()
    })

    expect(result.current.session).toBeNull()
    expect(result.current.supabaseUser).toBeNull()
  })
})

// A 503, a dropped connection or a failed /api/auth-config read cleared the
// session, so RequireAuth sent a validly signed-in student to a bare sign-in
// form. Only the server saying nobody is signed in may clear it now.
describe('a session read that gets no answer keeps the session', () => {
  const failing = (status?: number) => {
    const error = new Error(status ? 'Service unavailable' : 'Failed to fetch') as Error & { status?: number }
    if (status) error.status = status
    return error
  }

  // Mount with no Supabase session, so boot reads the cookie session.
  async function mountWithSessionRead(answer: (path: string) => unknown) {
    mocks.getSession.mockResolvedValue({ data: { session: null } })
    mocks.authRequest.mockImplementation(async (path: string) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return answer(path)
    })
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    return result
  }

  test('boot: a 503 from /api/session leaves the sign-in state unknown, not signed out', async () => {
    const result = await mountWithSessionRead((path) => {
      if (path === SESSION) throw failing(503)
      return { authProvider: 'local', purdueAuthMode: 'cas' }
    })
    expect(result.current.session).toBeNull()
    expect(result.current.sessionCheckFailed).toBe(true)
    // The config still arrived, so it is applied.
    expect(result.current.authConfig.purdueAuthMode).toBe('cas')
  })

  test('boot: a dropped connection leaves the sign-in state unknown', async () => {
    const result = await mountWithSessionRead((path) => {
      if (path === SESSION) throw failing()
      return { authProvider: 'local', purdueAuthMode: 'mock' }
    })
    expect(result.current.sessionCheckFailed).toBe(true)
  })

  test('boot: a 500 from /api/auth-config does not touch the session', async () => {
    const result = await mountWithSessionRead((path) => {
      if (path === '/api/auth-config') throw failing(500)
      return { authenticated: true, session: backendSession }
    })
    expect(result.current.session).toEqual(backendSession)
    expect(result.current.sessionCheckFailed).toBe(false)
    expect(result.current.authConfig).toEqual({ authProvider: 'local', purdueAuthMode: 'mock' })
  })

  test('boot: a reply that is not the session payload is no answer', async () => {
    const result = await mountWithSessionRead((path) => {
      if (path === SESSION) return '<html>Bad gateway</html>'
      return { authProvider: 'local', purdueAuthMode: 'mock' }
    })
    expect(result.current.sessionCheckFailed).toBe(true)
  })

  test('boot: the server saying nobody is signed in is a known signed-out state', async () => {
    const result = await mountWithSessionRead((path) => {
      if (path === SESSION) return { authenticated: false, session: null }
      return { authProvider: 'local', purdueAuthMode: 'mock' }
    })
    expect(result.current.session).toBeNull()
    expect(result.current.sessionCheckFailed).toBe(false)
  })

  test('boot: a Supabase session whose sync and cookie read both fail stays unknown', async () => {
    mocks.authRequest.mockImplementation(async (path: string) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (path === SYNC || path === SESSION) throw failing(502)
      return { authProvider: 'local', purdueAuthMode: 'mock' }
    })
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.sessionCheckFailed).toBe(true)
  })

  // A settings save the server accepted, followed by a re-read that answered
  // 503 once, signed the student out with no "Settings updated".
  test('refreshSession keeps and returns the session when the re-read fails', async () => {
    const result = await mountAuth()
    mocks.authRequest.mockImplementation(async () => {
      throw failing(503)
    })

    let returned: unknown
    await act(async () => {
      returned = await result.current.refreshSession()
    })

    expect(returned).toEqual(backendSession)
    expect(result.current.session).toEqual(backendSession)
    expect(result.current.sessionCheckFailed).toBe(true)
  })

  test('the next read that gets an answer clears the failure', async () => {
    const result = await mountAuth()
    mocks.authRequest.mockImplementationOnce(async () => {
      throw failing()
    })
    await act(async () => {
      await result.current.refreshSession()
    })
    expect(result.current.sessionCheckFailed).toBe(true)

    await act(async () => {
      await result.current.refreshSession()
    })
    expect(result.current.sessionCheckFailed).toBe(false)
    expect(result.current.session).toEqual(backendSession)
  })

  // "Stay signed in" answered by a 503 lost what the student had typed.
  test('establishSession keeps the session when neither the sync nor the re-read answers', async () => {
    const result = await mountAuth()
    mocks.authRequest.mockImplementation(async () => {
      throw failing(503)
    })

    let returned: unknown
    await act(async () => {
      returned = await result.current.establishSession()
    })

    expect(returned).toEqual(backendSession)
    expect(result.current.session).toEqual(backendSession)
    expect(result.current.sessionCheckFailed).toBe(true)
  })

  test('refreshSession still clears the session when the server says it ended', async () => {
    const result = await mountAuth()
    mocks.authRequest.mockResolvedValue({ authenticated: false, session: null })

    let returned: unknown
    await act(async () => {
      returned = await result.current.refreshSession()
    })

    expect(returned).toBeNull()
    expect(result.current.session).toBeNull()
    expect(result.current.sessionCheckFailed).toBe(false)
  })

  test('a 401 from /api/session counts as signed out', async () => {
    const result = await mountAuth()
    mocks.authRequest.mockImplementation(async () => {
      throw failing(401)
    })

    await act(async () => {
      await result.current.refreshSession()
    })

    expect(result.current.session).toBeNull()
    expect(result.current.sessionCheckFailed).toBe(false)
  })

  // Otherwise a guarded page visited after sign-out offered a retry instead of
  // the sign-in form.
  test('signing out clears an earlier failure', async () => {
    const result = await mountAuth()
    mocks.authRequest.mockImplementationOnce(async () => {
      throw failing()
    })
    await act(async () => {
      await result.current.refreshSession()
    })

    await act(async () => {
      await result.current.signOut()
    })

    expect(result.current.session).toBeNull()
    expect(result.current.sessionCheckFailed).toBe(false)
  })
})
