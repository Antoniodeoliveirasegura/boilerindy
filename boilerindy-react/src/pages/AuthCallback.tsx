import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { resolvePostLoginPath } from '../lib/authApi'

async function waitForSession(attempts = 10, delayMs = 200) {
  for (let i = 0; i < attempts; i += 1) {
    const { data } = await supabase.auth.getSession()
    if (data.session) return true
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return false
}

export default function AuthCallback() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { establishSession } = useAuth()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleCallback = async () => {
      try {
        const errorParam = searchParams.get('error')
        const errorDescription = searchParams.get('error_description')
        
        if (errorParam) {
          throw new Error(errorDescription || errorParam)
        }

        const { data: { session }, error: sessionError } = await supabase.auth.getSession()
        
        if (sessionError) {
          throw sessionError
        }

        if (!session) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(
            window.location.href
          )

          // detectSessionInUrl means the client may already be exchanging the
          // same PKCE code, which consumes the verifier and fails this call.
          // A session appearing shortly after means that race, not a failure.
          if (exchangeError && !(await waitForSession())) {
            throw exchangeError
          }
        }

        const backendSession = await establishSession()
        // Google drops us on a bare /auth/callback, so the destination comes
        // from the ?next stashed before the redirect (if any) plus the freshly
        // synced onboarding state - otherwise OAuth users land on the marketing
        // page instead of setup or the dashboard.
        const next = sessionStorage.getItem('postAuthNext')
        sessionStorage.removeItem('postAuthNext')
        const search = next ? `?next=${encodeURIComponent(next)}` : ''
        navigate(resolvePostLoginPath(search, backendSession?.onboarding), { replace: true })
      } catch (err) {
        console.error('Auth callback error:', err)
        setError(err instanceof Error ? err.message : 'Authentication failed')
        setTimeout(() => {
          navigate('/login?error=oauth-error', { replace: true })
        }, 2000)
      }
    }

    handleCallback()
  }, [navigate, establishSession, searchParams])

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--color-bg-1)]">
        <div className="text-center">
          <div className="text-[var(--color-error)] mb-2">Authentication failed</div>
          <div className="text-[var(--color-txt-2)] text-sm">{error}</div>
          <div className="text-[var(--color-txt-3)] text-xs mt-2">Redirecting to login...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex items-center justify-center bg-[var(--color-bg-1)]">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-[var(--color-gold)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <div className="text-[var(--color-txt-1)]">Completing sign in...</div>
      </div>
    </div>
  )
}
