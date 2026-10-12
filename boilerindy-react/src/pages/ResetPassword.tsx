import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, updateUserPassword } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { parseNextPath } from '../lib/authApi'
import BrandMark from '../components/BrandMark'
import Icon from '../components/Icons'
import StatusBanner from '../components/StatusBanner'
import PageTitle from '../components/PageTitle'

// Landing page for Supabase password-recovery links (sent from the Login
// "Forgot password?" form). Only PASSWORD_RECOVERY sessions may set a new
// password here - a normal signed-in session is redirected to Settings.

const LINK_CHECK_TIMEOUT_MS = 6000

// The same mark-and-name lockup as the advertiser reset page. The name is
// decorative here (aria-hidden), since this page never had a brand link.
function BrandLockup() {
  return (
    <div aria-hidden="true" className="topbar-brand mb-6">
      <BrandMark size={32} />
      BoilerIndy
    </div>
  )
}

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

  const labelClass = 'block mb-1.5 text-[13px] font-semibold text-[var(--color-txt-1)]'

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
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-12 sm:px-6">
        <PageTitle>Reset your password</PageTitle>
        <div className="w-full max-w-[420px]">
          <BrandLockup />
          <div className="card card-pad">
            <h1 className="page-title compact">Link expired or invalid</h1>
            <p className="page-sub mb-6">
              Reset links only work once and expire after a short while. Request a new one from the sign-in page.
            </p>
            <Link to="/login" className="btn btn-secondary min-h-11 w-full">
              <Icon name="arrowUpRight" size={14} className="rotate-[225deg]" />
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (linkState === 'checking') {
    return (
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <PageTitle>Reset your password</PageTitle>
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[var(--color-border-2)] border-t-[var(--color-txt-0)]" />
          <div className="text-[14px] text-[var(--color-txt-1)]">Checking your reset link…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-12 sm:px-6">
      <PageTitle>Reset your password</PageTitle>
      <div className="w-full max-w-[420px]">
        <BrandLockup />
        <div className="card card-pad">
          <h1 className="page-title compact">Set a new password</h1>
          <p className="page-sub mb-6">Choose a strong password for your account.</p>

          {message && (
            <StatusBanner tone="error" className="mb-4">
              {message}
            </StatusBanner>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="np" className={labelClass}>
                New password
              </label>
              <input
                id="np"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label htmlFor="npc" className={labelClass}>
                Confirm password
              </label>
              <input
                id="npc"
                type="password"
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="btn btn-primary min-h-11 w-full disabled:opacity-60"
            >
              {submitting ? 'Saving…' : 'Update password'}
            </button>
          </form>
        </div>

        <p className="mt-5 text-center text-[13px]">
          <Link to="/login" className="font-semibold text-[var(--color-accent)] hover:underline underline-offset-2">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
