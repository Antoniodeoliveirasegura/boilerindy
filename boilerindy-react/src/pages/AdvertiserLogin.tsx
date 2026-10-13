import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import BrandMark from '../components/BrandMark'
import Icon from '../components/Icons'
import SiteDisclaimer from '../components/SiteDisclaimer'
import {
  advertiserSignIn,
  getAdvertiserSession,
  requestAdvertiserAccess,
  requestAdvertiserPasswordReset,
} from '../lib/advertiserApi'
import SkipLink from '../components/SkipLink'
import PageTitle from '../components/PageTitle'

// Advertiser portal sign-in - a SEPARATE login from the student /login flow, for
// businesses and marketers who want to run ads on BoilerIndy. Wired to the
// isolated /api/advertiser/* backend: sign-in establishes an advertiser-only
// session (never a student session), and "Request access" persists a lead.
// A successful sign-in (or an existing session) routes to /advertise/dashboard.

const ADVERTISER_PERKS = [
  { icon: 'users', title: 'Reach the whole campus', desc: 'Get in front of Purdue Indianapolis students where they already plan their day.' },
  { icon: 'mapPin', title: 'Context & place targeting', desc: 'Show up next to dining, transit, or events - when intent is highest.' },
  { icon: 'grid', title: 'Native dashboard placements', desc: 'Sponsored widgets that fit the home dashboard instead of fighting it.' },
  { icon: 'star', title: 'Transparent analytics', desc: 'Impressions, taps, and reach - measured, not estimated.' },
]

// StatusBanner's info and error plates. Every notice here is role="status"
// (the errors too), so they are written out rather than going through
// StatusBanner, which would turn an error into an alert. Confirmations are
// neutral; only errors take a colour.
const NOTE_BASE = 'flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-l-4 px-3.5 py-2.5 text-[13.5px] font-medium'
const NOTE_INFO = `${NOTE_BASE} border-[var(--color-border-2)] border-l-[var(--color-txt-2)] bg-[var(--color-stat)] text-[var(--color-txt-1)]`
const NOTE_ERROR = `${NOTE_BASE} border-[var(--color-error)]/30 border-l-[var(--color-error)] bg-[var(--color-error)]/10 text-[var(--color-error)]`

// advertiserRequest sends an advertiser whose session ended here with
// ?message=session-expired. Only that fixed key shows a notice, so a crafted
// link cannot put its own words on the sign-in page.
const SESSION_EXPIRED_NOTICE = { type: 'info', text: 'Your advertiser session expired. Please sign in again.' }

export default function AdvertiserLogin() {
  const { dark, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // A signed-in student reaches this page from the account menu's "Advertiser
  // portal". "Back to site" and the brand sent them to the marketing landing
  // page, signed-out top bar and all, so they go back to the app instead.
  // Visitors still get the landing page.
  const { user } = useAuth()
  const siteHome = user ? '/dashboard' : '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState<{ type: string; text: string } | null>(() =>
    searchParams.get('message') === 'session-expired' ? SESSION_EXPIRED_NOTICE : null,
  )
  const [submitting, setSubmitting] = useState(false)

  // Request-access (lead) form - invite-only, so this is how new advertisers
  // raise their hand. Hidden until "Request access" is clicked.
  const [showRequest, setShowRequest] = useState(false)
  const [reqEmail, setReqEmail] = useState('')
  const [reqCompany, setReqCompany] = useState('')
  const [reqMessage, setReqMessage] = useState('')
  const [reqSubmitting, setReqSubmitting] = useState(false)
  const [reqDone, setReqDone] = useState(false)

  // Forgot-password: clicking "Forgot?" swaps the sign-in form for an email
  // form. Success is intentionally vague - the backend never reveals whether an
  // account exists, so neither do we.
  const [showForgot, setShowForgot] = useState(false)
  const [forgotSubmitting, setForgotSubmitting] = useState(false)
  const [forgotDone, setForgotDone] = useState(false)

  // Already signed in (e.g. after a refresh)? Skip the form, go to the dashboard.
  useEffect(() => {
    let active = true
    getAdvertiserSession()
      .then((profile) => {
        if (active && profile) navigate('/advertise/dashboard', { replace: true })
      })
      .catch(() => {
        /* backend unavailable - show the form (signed out resolves to null above) */
      })
    return () => {
      active = false
    }
  }, [navigate])

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!email.trim() || !password) {
      setNotice({ type: 'error', text: 'Enter your business email and password to continue.' })
      return
    }
    setSubmitting(true)
    setNotice(null)
    try {
      await advertiserSignIn(email.trim(), password)
      setPassword('')
      // Replace, as the student Login does: a pushed dashboard left this page
      // under it, so Back flashed the form, the effect above bounced to the
      // dashboard again, and it took two Backs to leave the portal.
      navigate('/advertise/dashboard', { replace: true })
    } catch (error) {
      setNotice({ type: 'error', text: (error instanceof Error && error.message) || 'Could not sign in. Please try again.' })
    } finally {
      setSubmitting(false)
    }
  }

  const handleForgot = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!email.trim()) {
      setNotice({ type: 'error', text: 'Enter your business email to get a reset link.' })
      return
    }
    setForgotSubmitting(true)
    setNotice(null)
    try {
      await requestAdvertiserPasswordReset(email.trim())
      setForgotDone(true)
    } catch (error) {
      setNotice({ type: 'error', text: (error instanceof Error && error.message) || 'Could not send a reset link. Please try again.' })
    } finally {
      setForgotSubmitting(false)
    }
  }

  const handleRequestAccess = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!reqEmail.trim()) {
      setNotice({ type: 'error', text: 'Enter a business email so we can reach you.' })
      return
    }
    setReqSubmitting(true)
    setNotice(null)
    try {
      await requestAdvertiserAccess({
        email: reqEmail.trim(),
        companyName: reqCompany.trim(),
        message: reqMessage.trim(),
      })
      setReqDone(true)
    } catch (error) {
      setNotice({ type: 'error', text: (error instanceof Error && error.message) || 'Could not submit your request. Please try again.' })
    } finally {
      setReqSubmitting(false)
    }
  }

  const labelClass = 'block text-[13px] font-semibold text-[var(--color-txt-1)]'
  const textLink = 'font-semibold text-[var(--color-accent)] hover:underline underline-offset-2'

  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] bg-[var(--color-bg-1)] text-[var(--color-txt-0)]">
      <PageTitle>Advertise</PageTitle>
      <SkipLink />
      {/* ── Brand / value panel: a neutral ink panel ──
          The ink fills the whole column; the content inside sticks at one
          viewport tall, so a long form scrolls past it instead of opening
          dead bands between the brand, the copy and the stats. */}
      <aside className="ink-panel rounded-none border-0 relative hidden lg:block">
        <div className="sticky top-0 flex h-screen min-h-fit flex-col justify-between gap-12 px-12 pt-8 pb-10 xl:px-16">
          <Link to={siteHome} className="topbar-brand w-fit">
            <BrandMark surface="ink" size={32} />
            BoilerIndy
          </Link>

          <div className="max-w-[500px]">
            {/* The sign chip from Landing, on the lifted tile so it stands off the ink. */}
            <div className="ink-panel inline-flex items-center overflow-hidden rounded-[4px] bg-[var(--color-ink-lift-2)] font-display text-[13px] font-extrabold tracking-[0.02em]">
              <span className="route-badge size-[34px] rounded-none">
                <Icon name="briefcase" size={18} />
              </span>
              <span className="pl-3 pr-3.5">Advertiser Portal</span>
            </div>
            <h1 className="page-title mt-7 text-[var(--color-ink-txt)]">
              Put your brand where students actually look.
            </h1>
            <p className="mt-5 max-w-[460px] text-[16px] leading-relaxed text-[var(--color-ink-dim)]">
              BoilerIndy is the daily home screen for Purdue Indianapolis student life. Reach them in context - without the noise of social feeds.
            </p>

            <ul className="mt-10 space-y-5">
              {ADVERTISER_PERKS.map((perk) => (
                <li key={perk.title} className="flex items-start gap-4">
                  <span className="route-badge">
                    <Icon name={perk.icon} size={18} />
                  </span>
                  <div className="min-w-0">
                    <div className="font-display text-[14.5px] font-bold leading-snug text-[var(--color-ink-txt)]">{perk.title}</div>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-ink-dim)]">{perk.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid max-w-[400px] grid-cols-[auto_minmax(0,1fr)] border-t-4 border-[var(--color-ink-txt)]">
            <div className="pt-4 pr-6">
              <div className="font-display text-[30px] xl:text-[34px] font-extrabold leading-none tracking-[-0.03em] text-[var(--color-ink-txt)]">Campus-wide</div>
              <div className="mt-2 text-[13px] text-[var(--color-ink-dim)]">Purdue Indianapolis</div>
            </div>
            <div className="border-l border-[var(--color-ink-edge)] pt-4 pl-6">
              <div className="font-display text-[30px] xl:text-[34px] font-extrabold leading-none tracking-[-0.03em] text-[var(--color-ink-txt)]">Daily</div>
              <div className="mt-2 text-[13px] text-[var(--color-ink-dim)]">Active student use</div>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Sign-in panel ───────────────────────────────────────────────── */}
      <main id="main" tabIndex={-1} className="relative flex min-w-0 flex-col px-4 pt-3 sm:px-10 sm:pt-5 lg:pt-[26px] focus:outline-none">
        <div className="flex items-center justify-between">
          <Link
            to={siteHome}
            className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-md)] px-2 font-display text-[13px] font-bold text-[var(--color-txt-2)] no-underline hover:text-[var(--color-txt-0)]"
          >
            <Icon name="arrowUpRight" size={14} className="rotate-[225deg]" />
            Back to site
          </Link>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="icon-btn -mr-2.5"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={18} />
          </button>
        </div>

        <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center py-8 sm:py-12 lg:py-8">
          {/* Mobile-only brand (the value panel is hidden under lg). */}
          <div className="mb-4 flex items-center gap-3 lg:hidden">
            <BrandMark size={30} />
            <span aria-hidden="true" className="h-5 w-px bg-[var(--color-border-3)]" />
            <span className="eyebrow bare">Advertiser Portal</span>
          </div>

          {notice && (
            <div role="status" className={`mb-5 ${notice.type === 'error' ? NOTE_ERROR : NOTE_INFO}`}>
              <Icon name={notice.type === 'error' ? 'close' : 'info'} size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{notice.text}</span>
            </div>
          )}

          <h2 className="page-title compact">
            {showForgot ? 'Reset your password' : 'Advertiser sign in'}
          </h2>
          <p className="page-sub mb-6">
            {showForgot
              ? 'Enter your business email and we’ll send you a reset link.'
              : 'Manage your campaigns and placements on BoilerIndy.'}
          </p>

          {showForgot ? (
            forgotDone ? (
              <div role="status" className={NOTE_INFO}>
                <Icon name="mail" size={16} className="mt-0.5 shrink-0" />
                <span className="min-w-0">If an advertiser account exists for that email, we’ve sent a reset link. Check your inbox - it expires in 1 hour.</span>
              </div>
            ) : (
              <form onSubmit={handleForgot} className="space-y-4">
                <div>
                  <label htmlFor="adv-forgot-email" className={`${labelClass} mb-1.5`}>
                    Business email
                  </label>
                  <input
                    id="adv-forgot-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="input"
                  />
                </div>
                <button
                  type="submit"
                  disabled={forgotSubmitting}
                  className="btn btn-primary min-h-11 w-full"
                >
                  <Icon name="send" size={15} />
                  {forgotSubmitting ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            )
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="adv-email" className={`${labelClass} mb-1.5`}>
                  Business email
                </label>
                <input
                  id="adv-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="input"
                />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <label htmlFor="adv-password" className={labelClass}>
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setShowForgot(true)
                      setNotice(null)
                    }}
                    className={`-my-3 inline-flex min-h-11 items-center bg-transparent p-0 text-[13px] ${textLink}`}
                  >
                    Forgot?
                  </button>
                </div>
                <input
                  id="adv-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="input"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="btn btn-primary min-h-11 w-full"
              >
                <Icon name="briefcase" size={15} />
                {submitting ? 'Signing in…' : 'Sign in to portal'}
              </button>
            </form>
          )}

          {showForgot ? (
            <button
              type="button"
              onClick={() => {
                setShowForgot(false)
                setForgotDone(false)
                setNotice(null)
              }}
              className={`mt-4 inline-flex min-h-11 w-fit items-center gap-1.5 bg-transparent p-0 text-[13px] ${textLink}`}
            >
              <Icon name="arrowUpRight" size={13} className="rotate-[225deg]" />
              Back to sign in
            </button>
          ) : (
            <>
              <div className="my-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-[var(--color-border-2)]" />
                <span className="eyebrow bare text-[var(--color-txt-3)]">New here</span>
                <div className="h-px flex-1 bg-[var(--color-border-2)]" />
              </div>

              {reqDone ? (
                <div role="status" className={NOTE_INFO}>
                  <Icon name="check" size={16} className="mt-0.5 shrink-0" />
                  <span className="min-w-0">Thanks - we’ve got your request. We’ll email you about advertiser access during the campus pilot.</span>
                </div>
              ) : showRequest ? (
                <form onSubmit={handleRequestAccess} className="space-y-3">
                  <input
                    type="email"
                    autoComplete="email"
                    value={reqEmail}
                    onChange={(e) => setReqEmail(e.target.value)}
                    placeholder="Business email"
                    aria-label="Business email"
                    className="input"
                  />
                  <input
                    type="text"
                    value={reqCompany}
                    onChange={(e) => setReqCompany(e.target.value)}
                    placeholder="Company (optional)"
                    aria-label="Company"
                    className="input"
                  />
                  <textarea
                    value={reqMessage}
                    onChange={(e) => setReqMessage(e.target.value)}
                    placeholder="What would you like to promote? (optional)"
                    aria-label="Message"
                    rows={3}
                    className="input resize-none"
                  />
                  <button
                    type="submit"
                    disabled={reqSubmitting}
                    className="btn btn-secondary min-h-11 w-full"
                  >
                    <Icon name="send" size={15} />
                    {reqSubmitting ? 'Sending…' : 'Submit request'}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setShowRequest(true)
                    setReqEmail(email)
                  }}
                  className="btn btn-secondary min-h-11 w-full"
                >
                  <Icon name="send" size={15} />
                  Request advertiser access
                </button>
              )}
            </>
          )}

          <div className="mt-8 border-t border-[var(--color-border-2)] pt-5 text-[13px] leading-relaxed text-[var(--color-txt-2)]">
            <p className="flex items-start gap-2.5">
              <Icon name="graduation" size={15} className="mt-[3px] text-[var(--color-txt-3)]" />
              <span>
                Looking for the student app?{' '}
                <Link to="/login" className={textLink}>Sign in here</Link>.
              </span>
            </p>
          </div>
        </div>

        <SiteDisclaimer note="Advertiser accounts are invite-only during the campus pilot" className="-mx-4 sm:-mx-10" rule />
      </main>
    </div>
  )
}
