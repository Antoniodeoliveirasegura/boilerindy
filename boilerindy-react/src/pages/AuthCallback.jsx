import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

export default function AuthCallback() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { refreshSession } = useAuth()
  const [error, setError] = useState(null)

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

        if (session) {
          await refreshSession()
          navigate('/', { replace: true })
        } else {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(
            window.location.href
          )
          
          if (exchangeError) {
            throw exchangeError
          }

          await refreshSession()
          navigate('/', { replace: true })
        }
      } catch (err) {
        console.error('Auth callback error:', err)
        setError(err.message)
        setTimeout(() => {
          navigate('/login?error=oauth-error', { replace: true })
        }, 2000)
      }
    }

    handleCallback()
  }, [navigate, refreshSession, searchParams])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-1)]">
        <div className="text-center">
          <div className="text-[var(--color-error)] mb-2">Authentication failed</div>
          <div className="text-[var(--color-txt-2)] text-sm">{error}</div>
          <div className="text-[var(--color-txt-3)] text-xs mt-2">Redirecting to login...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-1)]">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-[var(--color-gold)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <div className="text-[var(--color-txt-1)]">Completing sign in...</div>
      </div>
    </div>
  )
}
