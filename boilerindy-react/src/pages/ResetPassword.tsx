import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, updateUserPassword } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { parseNextPath } from '../lib/authApi'

// Landing page for Supabase password-recovery links (sent from the Login
// "Forgot password?" form). Only PASSWORD_RECOVERY sessions may set a new
// password here - a normal signed-in session is redirected to Settings.

const LINK_CHECK_TIMEOUT_MS = 6000

function readRecoveryError() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const queryParams = new URLSearchParams(window.location.search)
  return (
    hashParams.get('error_description') ||
    queryParams.get('error_description') ||
    hashParams.get('error') ||
    queryParams.get('error')
  )
}

export default function ResetPassword() {
  const navigate = useNavigate()
  const { establishSession } = useAuth()

  const [linkState, setLinkState] = useState<'checking' | 'ready' | 'invalid'>(() =>
    readRecoveryError() ? 'invalid' : 'checking',
  )
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (linkState !== 'checking') return undefined
    let active = true
    let sawRecovery = false

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return
      if (event === 'PASSWORD_RECOVERY' && session) {
        sawRecovery = true
        setLinkState('ready')
      }
    })

    const timer = window.setTimeout(() => {
      if (active && !sawRecovery) {
        setLinkState((state) => (state === 'checking' ? 'invalid' : state))
      }
    }, LINK_CHECK_TIMEOUT_MS)

    return () => {
      active = false
      subscription.unsubscribe()
      window.clearTimeout(timer)
    }
  }, [linkState])

  const inputBase =
    'w-full py-2.5 px-3.5 rounded-lg border border-[var(--color-border-2)] bg-[var(--color-bg-0)] dark:bg-[var(--color-bg-2)] text-[var(--color-txt-0)] text-sm outline-none focus:border-[var(--color-gold)] focus:shadow-[var(--shadow-glow)]'

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setMessage('')
    if (password.length < 8) {
      setMessage('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setMessage('Passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      await updateUserPassword(password)
      await establishSession()
      navigate(parseNextPath(''), { replace: true })
    } catch (error) {
      setMessage(
        error instanceof Error && error.message
          ? error.message
          : 'Could not reset the password. Request a new link and try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (linkState === 'invalid') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-[var(--color-bg-1)] text-center">
        <h1 className="text-xl font-semibold text-[var(--color-txt-0)] mb-2">Link expired or invalid</h1>
        <p className="text-sm text-[var(--color-txt-1)] mb-6 max-w-sm">
          Reset links only work once and expire after a short while. Request a new one from the sign-in page.
        </p>
        <Link to="/login" className="text-[var(--color-accent)] font-medium">
          Back to sign in
        </Link>
      </div>
    )
  }

  if (linkState === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-1)]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[var(--color-gold)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <div className="text-[var(--color-txt-1)]">Checking your reset link…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-[var(--color-bg-1)]">
      <div className="w-full max-w-[400px]">
        <h1 className="text-2xl font-bold text-[var(--color-txt-0)] mb-1">Set a new password</h1>
        <p className="text-[13px] text-[var(--color-txt-1)] mb-6">Choose a strong password for your account.</p>

        {message && (
          <div className="text-[13px] text-[var(--color-error)] mb-4 bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded-lg px-3 py-2">
            {message}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="np" className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">
              New password
            </label>
            <input
              id="np"
              type="password"
              className={inputBase}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label htmlFor="npc" className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">
              Confirm password
            </label>
            <input
              id="npc"
              type="password"
              className={inputBase}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 rounded-[10px] border-0 bg-[var(--color-gold-dark)] text-[var(--color-gold)] text-sm font-semibold hover:brightness-110 disabled:opacity-60"
          >
            {submitting ? 'Saving…' : 'Update password'}
          </button>
        </form>

        <p className="text-center mt-6 text-[13px]">
          <Link to="/login" className="text-[var(--color-accent)]">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
