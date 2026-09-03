import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './AuthContext'

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

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>

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
