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
import { clearAiCaches, clearUserStores } from '../lib/aiInsightCache'
import { dropUserQueries } from '../lib/queries/userData'
import {
  authRequest,
  getDisplayName,
  getFirstName,
  getInitials,
  startPurdueLink,
  type ApiRequestError,
} from '../lib/authApi'
import { clearSignupRef, signupRefField } from '../lib/signupRef'

type AuthUser = {
  name?: string | null
  email?: string | null
  /** The linked Purdue address (CAS, the dev mock or an emailed code, issue #181). */
  purdueEmail?: string | null
  hasPurdueLinked?: boolean
  /** True only after the student turns on AI suggestions in Settings. */
  aiOptIn?: boolean
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
  /** False when PURDUE_AUTH_MODE is off: no CAS or mock link, only an emailed code. */
  supportsPurdueLink?: boolean
}

type AuthContextValue = {
  session: BackendSession | null
  user: AuthUser | null
  supabaseUser: SupabaseUser | null
  onboarding: Onboarding
  loading: boolean
  /**
   * Whether this browser holds a Supabase session, read once at boot from
   * local storage before any server call; null until that read settles. The
   * sign-in page shows its form at once when this is false (issue #389): a
   * visitor with nothing stored needs no answer from the server to sign in.
   */
  hasStoredSession: boolean | null
  /**
   * True while the last session read got no answer: a 5xx, a dropped
   * connection or an unreadable reply. Whether the student is signed in is
   * then unknown, so the session the tab holds is kept as it is.
   */
  sessionCheckFailed: boolean
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

const DEFAULT_AUTH_CONFIG: AuthConfig = { authProvider: 'local', purdueAuthMode: 'mock' }

/**
 * GET /api/session. Resolves to the session, or to null only when the server
 * says nobody is signed in (its `session: null` answer, or a 401). Throws when
 * there is no such answer: a 5xx, a dropped connection, or a reply that is not
 * the session payload (a proxy's error page). Every one of those used to clear
 * the session, so a server restart or a flaky phone connection signed a
 * validly signed-in student out with no explanation.
 */
async function readServerSession(): Promise<BackendSession | null> {
  let data: unknown
  try {
    data = await authRequest('/api/session')
  } catch (error) {
    if ((error as ApiRequestError).status === 401) return null
    throw error
  }
  if (!data || typeof data !== 'object' || !('session' in data)) {
    throw new Error('The session reply could not be read.')
  }
  return (data as { session?: BackendSession | null }).session ?? null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BackendSession | null>(null)
  const [supabaseUser, setSupabaseUser] = useState<SupabaseUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasStoredSession, setHasStoredSession] = useState<boolean | null>(null)
  const [sessionCheckFailed, setSessionCheckFailed] = useState(false)
  const queryClient = useQueryClient()
  const [authConfig, setAuthConfig] = useState<AuthConfig>(DEFAULT_AUTH_CONFIG)

  // The session as last rendered, so a session read that gets no answer can
  // hand its caller the session the tab still holds, and sign-out knows whose
  // stores to clear.
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  // Does the backend session we are holding belong to the Supabase client
  // session, or did the sign-in form apply it straight from the server? Only
  // the first kind may be torn down by a SIGNED_OUT. Issue #298.
  const supabaseOwnsSession = useRef(false)

  // Set once anything after boot has decided the session: the sign-in form,
  // which now shows before boot's own read has answered (issue #389), a sync,
  // a re-read or a sign-out. Boot's read went out before any of them, so its
  // answer is older and is dropped rather than applied: on a cold start, a
  // student who signed in on the form was otherwise signed straight back out
  // when boot's read, sent before the cookie existed, came back empty.
  const sessionDecided = useRef(false)

  // The sync creates the account on a first Google sign-in, so it carries the
  // tab's sign-up source (lib/signupRef). The server saves it only for an
  // account it creates; after any sync that went through, the account exists
  // and the source is dropped.
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
            ...signupRefField(),
          }),
        })) as { session?: BackendSession | null }
        clearSignupRef()
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
  // A read that gets no answer keeps the session and returns it: clearing it
  // sent a student to the sign-in form right after a settings save the server
  // had accepted, because the re-read behind it answered 503 once.
  const refreshSession = useCallback(async (): Promise<BackendSession | null> => {
    try {
      const next = await readServerSession()
      sessionDecided.current = true
      setSession(next)
      setSessionCheckFailed(false)
      return next
    } catch {
      setSessionCheckFailed(true)
      return sessionRef.current
    }
  }, [])

  // Establish (or recover) the backend session from the current Supabase token:
  // POST /api/auth/supabase-sync re-validates the JWT and regenerates the session
  // cookie. Used on auth events (signup, OAuth callback, password reset, session
  // recovery) where minting the cookie is the point. Falls back to a plain
  // session re-read when there is no Supabase session. Issue #149. Like
  // refreshSession, a read that gets no answer keeps the session: "Stay signed
  // in" answered by a 503 used to sign the student out and lose what they had
  // typed.
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
          sessionDecided.current = true
          setSession(backendSession)
          setSessionCheckFailed(false)
          return backendSession
        }
      }

      // Fall back to regular backend session
      const next = await readServerSession()
      sessionDecided.current = true
      setSession(next)
      setSessionCheckFailed(false)
      return next
    } catch {
      setSessionCheckFailed(true)
      return sessionRef.current
    }
  }, [syncUserToBackend])

  // Set the backend session directly from a payload the server already returned
  // (e.g. POST /api/auth/sign-in), avoiding a refetch round-trip. Issue #111.
  const applySession = useCallback((next: BackendSession | null) => {
    // Straight from POST /api/auth/sign-in, so the cookie is authoritative and
    // survives a Supabase SIGNED_OUT. Issue #298.
    supabaseOwnsSession.current = false
    sessionDecided.current = true
    setSession(next)
    setSessionCheckFailed(false)
  }, [])

  useEffect(() => {
    let cancelled = false

    const initAuth = async () => {
      // The static auth-config runs alongside the session read (no waterfall,
      // issue #111), but a failed read falls back to the defaults on its own.
      // It shared a Promise.all with the session read, so a 500 from this
      // config signed a validly signed-in student out.
      const configRead = (authRequest('/api/auth-config') as Promise<AuthConfig>).catch(
        () => DEFAULT_AUTH_CONFIG,
      )
      try {
        const {
          data: { session: supabaseSession },
        } = await supabase.auth.getSession()

        if (cancelled) return
        setHasStoredSession(Boolean(supabaseSession))

        let backendSession: BackendSession | null = null

        if (supabaseSession) {
          supabaseOwnsSession.current = true
          setSupabaseUser(supabaseSession.user)
          // Sync establishes the backend session from the Supabase token.
          backendSession = await syncUserToBackend(supabaseSession)
          // Only fall back to the cookie session if the Supabase token no longer
          // syncs (expired server-side); otherwise /api/session is redundant.
          if (!backendSession) backendSession = await readServerSession()
        } else {
          backendSession = await readServerSession()
        }
        const config = await configRead

        if (cancelled) return

        if (!sessionDecided.current) setSession(backendSession)
        setAuthConfig(config)
      } catch {
        // No answer, so whether the student is signed in is unknown. Treating
        // that as signed out bounced them to a bare sign-in form on every
        // server hiccup and on every offline launch; RequireAuth now offers a
        // retry instead.
        const config = await configRead
        if (!cancelled) {
          if (!sessionDecided.current) setSessionCheckFailed(true)
          setAuthConfig(config)
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
          sessionDecided.current = true
          setSession(backendSession)
          setSessionCheckFailed(false)
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
          sessionDecided.current = true
          setSession(null)
          setSessionCheckFailed(false)
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
      // The student's grades, degree-planner major, schedule edits and
      // assistant conversation used to stay in browser storage after sign-out,
      // readable by the next person at this computer.
      clearUserStores(sessionRef.current?.user?.id as string | undefined)
      dropUserQueries(queryClient)
      // The tab stops acting as this student even when a request failed, so
      // a failed sign-out never leaves the account open behind the landing
      // page; useSignOutAndRedirect tells them the server may still hold it.
      supabaseOwnsSession.current = false
      sessionDecided.current = true
      setSession(null)
      // Signed out is a known state: a guarded page sends the visitor to the
      // sign-in form, not to the "cannot reach BoilerIndy" retry.
      setSessionCheckFailed(false)
      setSupabaseUser(null)
    }
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
      hasStoredSession,
      sessionCheckFailed,
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
      hasStoredSession,
      sessionCheckFailed,
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
    // Leave the signed-in page first. Clearing the session while a guarded
    // page was still on screen made RequireAuth send the student to
    // /login?next=<that page>, which flashed the sign-in form (or kept it,
    // when only the backend cookie held the session) instead of the landing
    // page. The landing page does not read the session, so it is a safe place
    // to wait for the sign-out to finish.
    navigate('/', { replace: true })
    try {
      await signOut()
    } catch {
      // Offline or a server error: this tab has let go of the session, but
      // the server may still hold it, and on a shared computer the next
      // person could reload into this account. Say so rather than leaving
      // the student on the landing page believing they are signed out.
      navigate('/login?error=sign-out-failed', { replace: true })
    }
  }, [navigate, signOut])
}
