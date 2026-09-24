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
import { useQueryClient } from '@tanstack/react-query'
import type { Session as SupabaseSession, User as SupabaseUser } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { clearAiCaches } from '../lib/aiInsightCache'
import { dropUserQueries } from '../lib/queries/userData'
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
  establishSession: () => Promise<BackendSession | null>
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
  const queryClient = useQueryClient()
  const [authConfig, setAuthConfig] = useState<AuthConfig>({
    authProvider: 'local',
    purdueAuthMode: 'mock',
  })

  // Does the backend session we are holding belong to the Supabase client
  // session, or did the sign-in form apply it straight from the server? Only
  // the first kind may be torn down by a SIGNED_OUT. Issue #298.
  const supabaseOwnsSession = useRef(false)

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
  // each trigger the SIGNED_IN listener AND an explicit establishSession(), and
  // every POST re-validates the JWT with Supabase before upserting the same row.
  // Callers racing on the same access token now share a single request.
  //
  // This coalesces in-flight calls only, it is NOT a cache. Once a sync settles
  // the next call goes to the network again, which matters because
  // establishSession() runs on auth events (signup, OAuth callback, password
  // reset, session recovery) that each need a freshly validated session, not a
  // remembered payload.
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

  // Re-read the existing backend session after mutating server state. Cheap: a
  // single GET /api/session, no Supabase auth round-trip. Used by callers that
  // are already authenticated and only need fresh session data (e.g. after
  // linking a schedule source or saving profile settings, issue #149). Does not
  // regenerate the cookie, so it must not be used to establish a new session.
  const refreshSession = useCallback(async (): Promise<BackendSession | null> => {
    try {
      const data = (await authRequest('/api/session')) as { session?: BackendSession | null }
      setSession(data.session ?? null)
      return data.session ?? null
    } catch {
      setSession(null)
      return null
    }
  }, [])

  // Establish (or recover) the backend session from the current Supabase token:
  // POST /api/auth/supabase-sync re-validates the JWT and regenerates the session
  // cookie. Used on auth events (signup, OAuth callback, password reset, session
  // recovery) where minting the cookie is the point. Falls back to a plain
  // session re-read when there is no Supabase session. Issue #149.
  const establishSession = useCallback(async (): Promise<BackendSession | null> => {
    try {
      // First check Supabase session
      const {
        data: { session: supabaseSession },
      } = await supabase.auth.getSession()

      if (supabaseSession) {
        setSupabaseUser(supabaseSession.user)
        const backendSession = await syncUserToBackend(supabaseSession)
        if (backendSession) {
          supabaseOwnsSession.current = true
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
    // Straight from POST /api/auth/sign-in, so the cookie is authoritative and
    // survives a Supabase SIGNED_OUT. Issue #298.
    supabaseOwnsSession.current = false
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
          supabaseOwnsSession.current = true
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
          supabaseOwnsSession.current = true
          setSession(backendSession)
        }
      } else if (event === 'SIGNED_OUT') {
        // Also fires without signOut(): a revoked or unrefreshable token, a
        // sign-out in another tab, or Login clearing a stale local session.
        // Drop the per-user AI caches (issue #219) but keep board drafts, which
        // are per user too and must survive a re-login (issue #23).
        clearAiCaches({ keepBoardDrafts: true })
        dropUserQueries(queryClient)
        setSupabaseUser(null)
        // The Supabase session is gone either way, but a backend session the
        // sign-in form applied was never Supabase's to revoke. Clearing it
        // anyway bounced a valid sign-in back to /login whenever the background
        // client sign-in failed and Login cleared its local session. Issue #298.
        if (supabaseOwnsSession.current) {
          supabaseOwnsSession.current = false
          setSession(null)
        }
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [syncUserToBackend, queryClient])

  const signOut = useCallback(async () => {
    try {
      // Sign out from Supabase
      await supabase.auth.signOut()
      // Sign out from backend
      await authRequest('/api/sign-out', { method: 'POST' })
    } finally {
      // Leave nothing personal on a shared computer (issue #219), even when a
      // request fails (offline, a cold-start 502), and after both awaits so an
      // insight written while they were in flight goes too. The query cache
      // holds this user's calendar, classes and tasks in memory (issue #327);
      // they go the same way. Only the ['me', ...] rows: clearing the whole
      // client would empty the public snapshot the next launch paints from.
      clearAiCaches()
      dropUserQueries(queryClient)
    }
    supabaseOwnsSession.current = false
    setSession(null)
    setSupabaseUser(null)
  }, [queryClient])

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
      establishSession,
      applySession,
      signOut,
      startPurdueLink,
      getInitials: () => getInitials(user?.name, user?.email),
      getDisplayName: () => getDisplayName(user),
      getFirstName: () => getFirstName(user),
    }),
    [
      session,
      user,
      supabaseUser,
      onboarding,
      loading,
      authConfig,
      refreshSession,
      establishSession,
      applySession,
      signOut,
    ],
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
