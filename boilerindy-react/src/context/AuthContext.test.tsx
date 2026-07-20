import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './AuthContext'

// Issue #111 - /api/auth/supabase-sync fired twice per login: once from the
// SIGNED_IN listener and once from an explicit refreshSession(). Each POST
// re-validates the JWT against Supabase before upserting the same row, so the
// duplicate is a wasted round-trip on the slowest path in the app.
//
// The fix coalesces in-flight calls sharing an access token. The tests that
// matter most are the negative ones: it must NOT behave like a cache, because
// ConnectSchedule, Settings and SessionExpiryWatcher call refreshSession()
// precisely because server state just changed.

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
    if (path === '/api/session') return { session: backendSession }
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
  test('two concurrent refreshSession calls issue one sync', async () => {
    const result = await mountAuth()

    await act(async () => {
      await Promise.all([result.current.refreshSession(), result.current.refreshSession()])
    })

    expect(syncCount()).toBe(1)
  })

  // The actual shape of the bug: signup and the OAuth callback both land here.
  test('the SIGNED_IN listener racing refreshSession issues one sync', async () => {
    const result = await mountAuth()

    await act(async () => {
      await Promise.all([
        emitAuthEvent('SIGNED_IN', makeSupabaseSession('tok-1')),
        result.current.refreshSession(),
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
        result.current.refreshSession(),
        result.current.refreshSession(),
      ])
    })

    expect(first).toEqual(backendSession)
    expect(second).toEqual(backendSession)
  })

  // Guards against "fixing" this with a TTL cache. ConnectSchedule, Settings and
  // SessionExpiryWatcher call refreshSession() right after mutating server
  // state; a remembered payload would show stale onboarding.
  test('sequential refreshSession calls each reach the network', async () => {
    const result = await mountAuth()

    await act(async () => {
      await result.current.refreshSession()
    })
    await act(async () => {
      await result.current.refreshSession()
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
      await result.current.refreshSession()
    })
    await act(async () => {
      await result.current.refreshSession()
    })

    // The in-flight entry must be cleared even when the request rejects,
    // otherwise every later login would be handed the failed promise.
    expect(syncCount()).toBe(2)
    expect(result.current.session).toEqual(backendSession)
  })
})
