import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { resolvePostLoginPath } from '../lib/authApi'
import PageTitle from '../components/PageTitle'

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
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <PageTitle>Signing in</PageTitle>
        <div className="card card-pad w-full max-w-[420px] border-l-4 border-l-[var(--color-error)]">
          <div className="font-display text-[15px] font-bold text-[var(--color-error)]">Authentication failed</div>
          <div className="mt-1 text-[13.5px] text-[var(--color-txt-1)] [overflow-wrap:anywhere]">{error}</div>
          <div className="mt-2 text-[12.5px] text-[var(--color-txt-3)]">Redirecting to login...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12">
      <PageTitle>Signing in</PageTitle>
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[var(--color-border-2)] border-t-[var(--color-txt-0)]" />
        <div className="text-[14px] text-[var(--color-txt-1)]">Completing sign in...</div>
      </div>
    </div>
  )
}
