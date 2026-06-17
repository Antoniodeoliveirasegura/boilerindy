import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import Icon from '../components/Icons'
import { resetAdvertiserPassword } from '../lib/advertiserApi'

// Landing page for the advertiser reset-password email link
// (/advertise/reset-password?token=…). Posts the token + new password to the
// isolated /api/advertiser/reset-password endpoint, then routes back to sign in.
// The token is single-use and expires after 1 hour (enforced server-side).

const MIN_PASSWORD_LENGTH = 8
const INPUT_CLASS =
  'w-full rounded-xl border border-[var(--color-border-2)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)] outline-none focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20 transition-shadow'

export default function AdvertiserResetPassword() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<{ type: string; text: string } | null>(null)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (password.length < MIN_PASSWORD_LENGTH) {
      setNotice({ type: 'error', text: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` })
      return
    }
    if (password !== confirm) {
      setNotice({ type: 'error', text: 'Passwords do not match.' })
      return
    }
    setSubmitting(true)
    setNotice(null)
    try {
      await resetAdvertiserPassword(token, password)
      setDone(true)
      setTimeout(() => navigate('/advertise'), 2500)
    } catch (error) {
      setNotice({ type: 'error', text: (error instanceof Error && error.message) || 'Could not reset your password. Please try again.' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-0)] text-[var(--color-txt-0)] px-6 py-12">
      <div className="w-full max-w-[400px]">
        <Link to="/advertise" className="inline-flex items-center gap-2.5 text-[15px] font-semibold text-[var(--color-txt-0)] no-underline mb-8">
          <span className="bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2.5 py-1 rounded-md tracking-wide">BI</span>
          BoilerIndy
        </Link>

        <div className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-gold)] bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/30 rounded-full px-3.5 py-1.5 mb-6 w-fit">
          <Icon name="briefcase" size={13} />
          Advertiser Portal
        </div>

        {notice && (
          <div
            role="alert"
            className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/8 text-[var(--color-error)] p-3.5 mb-5 text-[13px] leading-relaxed"
          >
            {notice.text}
          </div>
        )}

        {done ? (
          <div
            role="status"
            className="rounded-xl border border-[var(--color-gold)]/30 bg-[var(--color-gold)]/10 p-4 text-[13px] leading-relaxed text-[var(--color-txt-1)]"
          >
            Your password has been reset. Redirecting you to sign in…
          </div>
        ) : !token ? (
          <>
            <h1 className="text-[1.6rem] font-bold tracking-tight mb-1.5">Reset link invalid</h1>
            <p className="text-[13px] text-[var(--color-txt-2)] mb-7">
              This password reset link is missing or has expired. Request a new one from the sign-in page.
            </p>
            <Link to="/advertise" className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-accent)] hover:underline">
              <Icon name="arrowUpRight" size={13} className="rotate-[225deg]" />
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-[1.6rem] font-bold tracking-tight mb-1.5">Set a new password</h1>
            <p className="text-[13px] text-[var(--color-txt-2)] mb-7">
              Choose a new password for your BoilerIndy advertiser account.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="adv-new-password" className="block text-[12px] font-semibold text-[var(--color-txt-1)] mb-1.5">
                  New password
                </label>
                <input
                  id="adv-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor="adv-confirm-password" className="block text-[12px] font-semibold text-[var(--color-txt-1)] mb-1.5">
                  Confirm password
                </label>
                <input
                  id="adv-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter your password"
                  className={INPUT_CLASS}
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-5 py-3 rounded-xl border-0 cursor-pointer hover:brightness-105 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Icon name="briefcase" size={15} />
                {submitting ? 'Saving…' : 'Reset password'}
              </button>
            </form>
            <p className="text-[12px] text-[var(--color-txt-3)] text-center mt-6">
              <Link to="/advertise" className="text-[var(--color-accent)] hover:underline">Back to sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
