import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import BrandMark from '../components/BrandMark'
import Icon from '../components/Icons'
import StatusBanner from '../components/StatusBanner'
import { resetAdvertiserPassword } from '../lib/advertiserApi'
import PageTitle from '../components/PageTitle'

// Landing page for the advertiser reset-password email link
// (/advertise/reset-password?token=…). Posts the token + new password to the
// isolated /api/advertiser/reset-password endpoint, then routes back to sign in.
// The token is single-use and expires after 1 hour (enforced server-side).

const MIN_PASSWORD_LENGTH = 8
const LABEL_CLASS = 'block mb-1.5 text-[13px] font-semibold text-[var(--color-txt-1)]'
const TEXT_LINK = 'font-semibold text-[var(--color-accent)] hover:underline underline-offset-2'
// StatusBanner's neutral info plate, kept as a plain role="status" note (the
// component would also add aria-live).
const NOTE_INFO =
  'flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-l-4 border-[var(--color-border-2)] border-l-[var(--color-txt-2)] bg-[var(--color-stat)] px-3.5 py-2.5 text-[13.5px] font-medium text-[var(--color-txt-1)]'

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
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-12 text-[var(--color-txt-0)] sm:px-6">
      <PageTitle>Reset your advertiser password</PageTitle>
      <div className="w-full max-w-[420px]">
        <Link to="/advertise" className="topbar-brand mb-6">
          <BrandMark size={32} />
          BoilerIndy
        </Link>

        <div className="card card-pad">
          <div className="eyebrow mb-4">Advertiser Portal</div>

          {notice && (
            <StatusBanner tone="error" className="mb-5">
              {notice.text}
            </StatusBanner>
          )}

          {done ? (
            <div role="status" className={NOTE_INFO}>
              <Icon name="check" size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0">Your password has been reset. Redirecting you to sign in…</span>
            </div>
          ) : !token ? (
            <>
              <h1 className="page-title compact">Reset link invalid</h1>
              <p className="page-sub mb-6">
                This password reset link is missing or has expired. Request a new one from the sign-in page.
              </p>
              <Link to="/advertise" className="btn btn-secondary min-h-11 w-full">
                <Icon name="arrowUpRight" size={14} className="rotate-[225deg]" />
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="page-title compact">Set a new password</h1>
              <p className="page-sub mb-6">
                Choose a new password for your BoilerIndy advertiser account.
              </p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="adv-new-password" className={LABEL_CLASS}>
                    New password
                  </label>
                  <input
                    id="adv-new-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="input"
                  />
                </div>
                <div>
                  <label htmlFor="adv-confirm-password" className={LABEL_CLASS}>
                    Confirm password
                  </label>
                  <input
                    id="adv-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Re-enter your password"
                    className="input"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="btn btn-primary min-h-11 w-full"
                >
                  <Icon name="briefcase" size={15} />
                  {submitting ? 'Saving…' : 'Reset password'}
                </button>
              </form>
            </>
          )}
        </div>

        {token && !done ? (
          <p className="mt-5 text-center text-[13px]">
            <Link to="/advertise" className={TEXT_LINK}>Back to sign in</Link>
          </p>
        ) : null}
      </div>
    </div>
  )
}
