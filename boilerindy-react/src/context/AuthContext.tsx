import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import type { Session as SupabaseSession, User as SupabaseUser } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import {
  authRequest,
  getDisplayName,
  getFirstName,
  getInitials,
  startPurdueLink,
} from '../lib/authApi'

type AuthUser = {
  name?: string | null
  email?: string | null
  [key: string]: unknown
}

type Onboarding = {
  linkedSourceCount: number
  classCount: number
  hasPurdueLinked: boolean
  needsPurdueConnection: boolean
  needsScheduleSource: boolean
}

export type BackendSession = {
  user?: AuthUser | null
  onboarding?: Onboarding | null
  [key: string]: unknown
}

type AuthConfig = {
  authProvider: string
  purdueAuthMode: string
}

type AuthContextValue = {
  session: BackendSession | null
  user: AuthUser | null
  supabaseUser: SupabaseUser | null
  onboarding: Onboarding
  loading: boolean
  authConfig: AuthConfig
  refreshSession: () => Promise<BackendSession | null>
  applySession: (session: BackendSession | null) => void
  signOut: () => Promise<void>
  startPurdueLink: typeof startPurdueLink
  getInitials: () => string
  getDisplayName: () => string
  getFirstName: () => string
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BackendSession | null>(null)
  const [supabaseUser, setSupabaseUser] = useState<SupabaseUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [authConfig, setAuthConfig] = useState<AuthConfig>({
    authProvider: 'local',
    purdueAuthMode: 'mock',
  })

  const postSync = useCallback(
    async (supabaseSession: SupabaseSession): Promise<BackendSession | null> => {
      try {
        const response = (await authRequest('/api/auth/supabase-sync', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${supabaseSession.access_token}`,
          },
          body: JSON.stringify({
            supabaseUserId: supabaseSession.user.id,
            email: supabaseSession.user.email,
            name:
              supabaseSession.user.user_metadata?.full_name ||
              supabaseSession.user.user_metadata?.name ||
              supabaseSession.user.email?.split('@')[0],
            avatarUrl: supabaseSession.user.user_metadata?.avatar_url,
            provider: supabaseSession.user.app_metadata?.provider || 'email',
          }),
        })) as { session?: BackendSession | null }
        return response.session ?? null
      } catch (error) {
        console.error('Failed to sync user to backend:', error)
        return null
      }
    },
    [],
  )

  // One sync per login, not two (issue #111). Signing up and the OAuth callback
  // each trigger the SIGNED_IN listener AND an explicit refreshSession(), and
  // every POST re-validates the JWT with Supabase before upserting the same row.
  // Callers racing on the same access token now share a single request.
  //
  // This coalesces in-flight calls only, it is NOT a cache. Once a sync settles
  // the next call goes to the network again, which matters because
  // ConnectSchedule, Settings and SessionExpiryWatcher call refreshSession()
  // precisely because server state just changed; handing them a remembered
  // payload would render stale onboarding.
  const inFlightSync = useRef<{
    token: string
    promise: Promise<BackendSession | null>
  } | null>(null)

  const syncUserToBackend = useCallback(
    async (supabaseSession: SupabaseSession): Promise<BackendSession | null> => {
      if (!supabaseSession?.user) return null

      const token = supabaseSession.access_token
      const pending = inFlightSync.current
      if (pending && pending.token === token) return pending.promise

      const promise = postSync(supabaseSession)
      inFlightSync.current = { token, promise }
      try {
        return await promise
      } finally {
        if (inFlightSync.current?.promise === promise) inFlightSync.current = null
      }
    },
    [postSync],
  )

  const refreshSession = useCallback(async (): Promise<BackendSession | null> => {
    try {
      // First check Supabase session
      const {
        data: { session: supabaseSession },
      } = await supabase.auth.getSession()

      if (supabaseSession) {
        setSupabaseUser(supabaseSession.user)
        const backendSession = await syncUserToBackend(supabaseSession)
        if (backendSession) {
          setSession(backendSession)
          return backendSession
        }
      }

      // Fall back to regular backend session
      const data = (await authRequest('/api/session')) as { session?: BackendSession | null }
      setSession(data.session ?? null)
      return data.session ?? null
    } catch {
      setSession(null)
      return null
    }
  }, [syncUserToBackend])

  // Set the backend session directly from a payload the server already returned
  // (e.g. POST /api/auth/sign-in), avoiding a refetch round-trip. Issue #111.
  const applySession = useCallback((next: BackendSession | null) => {
    setSession(next)
  }, [])

  useEffect(() => {
    let cancelled = false

    const initAuth = async () => {
      try {
        const {
          data: { session: supabaseSession },
        } = await supabase.auth.getSession()

        if (cancelled) return

        let backendSession: BackendSession | null = null
        let config: AuthConfig = { authProvider: 'local', purdueAuthMode: 'mock' }

        if (supabaseSession) {
          setSupabaseUser(supabaseSession.user)
          // Sync (which establishes the backend session from the Supabase token)
          // and the static auth-config run together - no waterfall. Issue #111.
          const [synced, cfg] = (await Promise.all([
            syncUserToBackend(supabaseSession),
            authRequest('/api/auth-config'),
          ])) as [BackendSession | null, AuthConfig]
          backendSession = synced
          config = cfg
          // Only fall back to the cookie session if the Supabase token no longer
          // syncs (expired server-side); otherwise /api/session is redundant.
          if (!backendSession) {
            const sessionData = (await authRequest('/api/session')) as {
              session?: BackendSession | null
            }
            backendSession = sessionData.session ?? null
          }
        } else {
          const [sessionData, cfg] = (await Promise.all([
            authRequest('/api/session'),
            authRequest('/api/auth-config'),
          ])) as [{ session?: BackendSession | null }, AuthConfig]
          backendSession = sessionData.session ?? null
          config = cfg
        }

        if (cancelled) return

        setSession(backendSession)
        setAuthConfig(config)
      } catch {
        if (!cancelled) {
          setSession(null)
          setAuthConfig({ authProvider: 'local', purdueAuthMode: 'mock' })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    initAuth()

    // Listen for Supabase auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, supabaseSession) => {
      if (cancelled) return

      if (event === 'SIGNED_IN' && supabaseSession) {
        setSupabaseUser(supabaseSession.user)
        const backendSession = await syncUserToBackend(supabaseSession)
        if (backendSession) {
          setSession(backendSession)
        }
      } else if (event === 'SIGNED_OUT') {
        setSupabaseUser(null)
        setSession(null)
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [syncUserToBackend])

  const signOut = useCallback(async () => {
    // Sign out from Supabase
    await supabase.auth.signOut()
    // Sign out from backend
    await authRequest('/api/sign-out', { method: 'POST' })
    setSession(null)
    setSupabaseUser(null)
  }, [])

  const user = session?.user ?? null
  const onboarding = useMemo<Onboarding>(
    () =>
      session?.onboarding ?? {
        linkedSourceCount: 0,
        classCount: 0,
        hasPurdueLinked: false,
        needsPurdueConnection: true,
        needsScheduleSource: false,
      },
    [session],
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      supabaseUser,
      onboarding,
      loading,
      authConfig,
      refreshSession,
      applySession,
      signOut,
      startPurdueLink,
      getInitials: () => getInitials(user?.name, user?.email),
      getDisplayName: () => getDisplayName(user),
      getFirstName: () => getFirstName(user),
    }),
    [session, user, supabaseUser, onboarding, loading, authConfig, refreshSession, applySession, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSignOutAndRedirect() {
  const navigate = useNavigate()
  const { signOut } = useAuth()

  return useCallback(async () => {
    await signOut()
    navigate('/', { replace: true })
  }, [navigate, signOut])
}
