import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { authRequest } from '../lib/authApi'

export default function ResetPassword() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token')
  const err = searchParams.get('error')

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  const inputBase =
    'w-full py-2.5 px-3.5 rounded-lg border border-[var(--color-border-2)] bg-[var(--color-bg-0)] dark:bg-[var(--color-bg-2)] text-[var(--color-txt-0)] text-sm outline-none focus:border-[var(--color-gold)] focus:shadow-[var(--shadow-glow)]'

  async function handleSubmit(e) {
    e.preventDefault()
    setMessage('')
    if (!token) {
      setMessage('Missing reset token. Open the link from your email again.')
      return
    }
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
      await authRequest('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword: password }),
      })
      navigate('/login', { replace: true })
    } catch (e) {
      setMessage(e.message || 'Could not reset password.')
    } finally {
      setSubmitting(false)
    }
  }

  if (err === 'INVALID_TOKEN') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-[var(--color-bg-1)] text-center">
        <h1 className="text-xl font-semibold text-[var(--color-txt-0)] mb-2">Link expired or invalid</h1>
        <p className="text-sm text-[var(--color-txt-1)] mb-6 max-w-sm">
          Request a new reset link from the sign-in page.
        </p>
        <Link to="/login" className="text-[var(--color-accent)] font-medium">
          Back to sign in
        </Link>
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
            disabled={submitting || !token}
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
