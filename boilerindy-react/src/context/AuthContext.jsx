import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  authRequest,
  getDisplayName,
  getFirstName,
  getInitials,
  startPurdueLink,
} from '../lib/authApi'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [supabaseUser, setSupabaseUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authConfig, setAuthConfig] = useState({ authProvider: 'local', purdueAuthMode: 'mock' })

  const syncUserToBackend = useCallback(async (supabaseSession) => {
    if (!supabaseSession?.user) return null
    
    try {
      const response = await authRequest('/api/auth/supabase-sync', {
        method: 'POST',
        body: JSON.stringify({
          supabaseUserId: supabaseSession.user.id,
          email: supabaseSession.user.email,
          name: supabaseSession.user.user_metadata?.full_name || 
                supabaseSession.user.user_metadata?.name ||
                supabaseSession.user.email?.split('@')[0],
          avatarUrl: supabaseSession.user.user_metadata?.avatar_url,
          provider: supabaseSession.user.app_metadata?.provider || 'email',
          accessToken: supabaseSession.access_token,
        }),
      })
      return response.session
    } catch (error) {
      console.error('Failed to sync user to backend:', error)
      return null
    }
  }, [])

  const refreshSession = useCallback(async () => {
    try {
      // First check Supabase session
      const { data: { session: supabaseSession } } = await supabase.auth.getSession()
      
      if (supabaseSession) {
        setSupabaseUser(supabaseSession.user)
        const backendSession = await syncUserToBackend(supabaseSession)
        if (backendSession) {
          setSession(backendSession)
          return backendSession
        }
      }
      
      // Fall back to regular backend session
      const data = await authRequest('/api/session')
      setSession(data.session ?? null)
      return data.session ?? null
    } catch {
      setSession(null)
      return null
    }
  }, [syncUserToBackend])

  useEffect(() => {
    let cancelled = false

    const initAuth = async () => {
      try {
        // Get Supabase session first
        const { data: { session: supabaseSession } } = await supabase.auth.getSession()
        
        if (cancelled) return

        if (supabaseSession) {
          setSupabaseUser(supabaseSession.user)
          const backendSession = await syncUserToBackend(supabaseSession)
          if (backendSession) {
            setSession(backendSession)
          }
        }

        // Also check backend session
        const [sessionData, config] = await Promise.all([
          authRequest('/api/session'),
          authRequest('/api/auth-config'),
        ])
        
        if (cancelled) return
        
        // Prefer Supabase session if available
        if (!supabaseSession) {
          setSession(sessionData.session ?? null)
        }
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
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, supabaseSession) => {
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
  const onboarding = useMemo(() => (
    session?.onboarding ?? {
      linkedSourceCount: 0,
      classCount: 0,
      hasPurdueLinked: false,
      needsPurdueConnection: true,
      needsScheduleSource: false,
    }
  ), [session])

  const value = useMemo(
    () => ({
      session,
      user,
      supabaseUser,
      onboarding,
      loading,
      authConfig,
      refreshSession,
      signOut,
      startPurdueLink,
      getInitials: () => getInitials(user?.name, user?.email),
      getDisplayName: () => getDisplayName(user),
      getFirstName: () => getFirstName(user),
    }),
    [session, user, supabaseUser, onboarding, loading, authConfig, refreshSession, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
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
