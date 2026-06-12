import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import Icon from '../components/Icons'
import {
  advertiserSignIn,
  advertiserSignOut,
  getAdvertiserSession,
  requestAdvertiserAccess,
} from '../lib/advertiserApi'

// Advertiser portal sign-in — a SEPARATE login from the student /login flow, for
// businesses and marketers who want to run ads on BoilerIndy. Wired to the
// isolated /api/advertiser/* backend: sign-in establishes an advertiser-only
// session (never a student session), and "Request access" persists a lead.
// The campaigns dashboard lands in M2; for now a successful sign-in shows an
// authenticated panel here.

const ADVERTISER_PERKS = [
  { icon: 'users', title: 'Reach the whole campus', desc: 'Get in front of Purdue Indianapolis students where they already plan their day.' },
  { icon: 'mapPin', title: 'Context & place targeting', desc: 'Show up next to dining, transit, or events — when intent is highest.' },
  { icon: 'grid', title: 'Native dashboard placements', desc: 'Sponsored widgets that fit the home dashboard instead of fighting it.' },
  { icon: 'star', title: 'Transparent analytics', desc: 'Impressions, taps, and reach — measured, not estimated.' },
]

export default function AdvertiserLogin() {
  const { dark, toggleTheme } = useTheme()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [advertiser, setAdvertiser] = useState(null)

  // Request-access (lead) form — invite-only, so this is how new advertisers
  // raise their hand. Hidden until "Request access" is clicked.
  const [showRequest, setShowRequest] = useState(false)
  const [reqEmail, setReqEmail] = useState('')
  const [reqCompany, setReqCompany] = useState('')
  const [reqMessage, setReqMessage] = useState('')
  const [reqSubmitting, setReqSubmitting] = useState(false)
  const [reqDone, setReqDone] = useState(false)

  // Reflect an existing advertiser session (e.g. after a refresh).
  useEffect(() => {
    let active = true
    getAdvertiserSession()
      .then((profile) => {
        if (active && profile) setAdvertiser(profile)
      })
      .catch(() => {
        /* not signed in / backend unavailable — show the form */
      })
    return () => {
      active = false
    }
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!email.trim() || !password) {
      setNotice({ type: 'error', text: 'Enter your business email and password to continue.' })
      return
    }
    setSubmitting(true)
    setNotice(null)
    try {
      const { session } = await advertiserSignIn(email.trim(), password)
      setAdvertiser(session?.advertiser || null)
      setPassword('')
    } catch (error) {
      setNotice({ type: 'error', text: error.message || 'Could not sign in. Please try again.' })
    } finally {
      setSubmitting(false)
    }
  }

  const handleSignOut = async () => {
    try {
      await advertiserSignOut()
    } catch {
      /* ignore — clear the UI either way */
    }
    setAdvertiser(null)
    setNotice(null)
  }

  const handleRequestAccess = async (e) => {
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
      setNotice({ type: 'error', text: error.message || 'Could not submit your request. Please try again.' })
    } finally {
      setReqSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_0.95fr] bg-[var(--color-bg-0)] text-[var(--color-txt-0)]">
      {/* ── Brand / value panel ─────────────────────────────────────────── */}
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden p-12 bg-gradient-to-br from-[var(--color-gold-dark)] via-[#4a3209] to-[#1e1606] dark:from-[#1a1206] dark:via-[#241a08] dark:to-[#100b04]">
        <div className="hero-bg" aria-hidden="true">
          <div className="hero-bg__aurora hero-bg__aurora--gold" />
          <div className="hero-bg__aurora hero-bg__aurora--gold2" />
        </div>

        <Link to="/" className="relative inline-flex items-center gap-2.5 text-[15px] font-semibold text-[var(--color-gold-light)] no-underline w-fit">
          <span className="bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2.5 py-1 rounded-md tracking-wide">BI</span>
          BoilerIndy
        </Link>

        <div className="relative max-w-[440px]">
          <div className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-gold)] bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/30 rounded-full px-3.5 py-1.5 mb-6 tracking-wide">
            <Icon name="briefcase" size={13} />
            Advertiser Portal
          </div>
          <h1 className="text-[clamp(2rem,3.4vw,2.9rem)] font-bold tracking-[-0.02em] leading-tight text-[var(--color-gold-light)] mb-4">
            Put your brand where students actually look.
          </h1>
          <p className="text-[15px] text-[var(--color-gold-light)]/70 leading-relaxed mb-8">
            BoilerIndy is the daily home screen for Purdue Indianapolis student life. Reach them in context — without the noise of social feeds.
          </p>

          <ul className="list-none m-0 p-0 space-y-4">
            {ADVERTISER_PERKS.map((perk) => (
              <li key={perk.title} className="flex gap-3.5">
                <div className="w-9 h-9 shrink-0 rounded-lg bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/25 text-[var(--color-gold-light)] flex items-center justify-center">
                  <Icon name={perk.icon} size={16} />
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-[var(--color-gold-light)]">{perk.title}</div>
                  <p className="text-[12px] text-[var(--color-gold-light)]/55 mt-0.5 leading-relaxed">{perk.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center gap-6 text-[var(--color-gold-light)]/70">
          <div>
            <div className="text-[20px] font-bold text-[var(--color-gold-light)] leading-none">Campus-wide</div>
            <div className="text-[11px] mt-1">Purdue Indianapolis</div>
          </div>
          <div className="w-px h-8 bg-[var(--color-gold)]/20" />
          <div>
            <div className="text-[20px] font-bold text-[var(--color-gold-light)] leading-none">Daily</div>
            <div className="text-[11px] mt-1">Active student use</div>
          </div>
        </div>
      </aside>

      {/* ── Sign-in panel ───────────────────────────────────────────────── */}
      <main className="relative flex flex-col px-6 sm:px-10 py-8">
        <div className="flex items-center justify-between">
          <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)] no-underline">
            <Icon name="arrowUpRight" size={14} className="rotate-[225deg]" />
            Back to site
          </Link>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] transition-colors"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={16} />
          </button>
        </div>

        <div className="flex-1 flex flex-col justify-center max-w-[400px] w-full mx-auto py-10">
          {/* Mobile-only brand (the value panel is hidden under lg). */}
          <div className="lg:hidden inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-gold)] bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/30 rounded-full px-3.5 py-1.5 mb-6 w-fit">
            <Icon name="briefcase" size={13} />
            Advertiser Portal
          </div>

          {notice && (
            <div
              role="status"
              className={`rounded-xl border p-3.5 mb-5 text-[13px] leading-relaxed ${
                notice.type === 'error'
                  ? 'border-[var(--color-error)]/30 bg-[var(--color-error)]/8 text-[var(--color-error)]'
                  : 'border-[var(--color-gold)]/30 bg-[var(--color-gold)]/10 text-[var(--color-txt-1)]'
              }`}
            >
              {notice.text}
            </div>
          )}

          {advertiser ? (
            /* Signed-in panel. The campaigns dashboard arrives in M2; for now this
               confirms the isolated advertiser session works end to end. */
            <div role="status">
              <div className="inline-flex items-center gap-2 text-[11px] font-semibold text-[var(--color-gold)] bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/30 rounded-full px-3 py-1 mb-5 w-fit">
                <Icon name="check" size={12} />
                Signed in
              </div>
              <h2 className="text-[1.6rem] font-bold tracking-tight mb-1.5">
                Welcome, {advertiser.companyName}
              </h2>
              <p className="text-[13px] text-[var(--color-txt-2)] mb-7">
                You’re signed in to the advertiser portal as {advertiser.email}. The campaigns dashboard is coming soon.
              </p>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-[var(--color-txt-0)] px-5 py-3 rounded-xl border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] cursor-pointer transition-colors"
              >
                <Icon name="close" size={15} />
                Sign out
              </button>
            </div>
          ) : (
            <>
              <h2 className="text-[1.6rem] font-bold tracking-tight mb-1.5">Advertiser sign in</h2>
              <p className="text-[13px] text-[var(--color-txt-2)] mb-7">
                Manage your campaigns and placements on BoilerIndy.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="adv-email" className="block text-[12px] font-semibold text-[var(--color-txt-1)] mb-1.5">
                    Business email
                  </label>
                  <input
                    id="adv-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full rounded-xl border border-[var(--color-border-2)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)] outline-none focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20 transition-shadow"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="adv-password" className="text-[12px] font-semibold text-[var(--color-txt-1)]">
                      Password
                    </label>
                    <button type="button" className="text-[11px] text-[var(--color-accent)] hover:underline bg-transparent border-0 p-0 cursor-pointer">
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
                    className="w-full rounded-xl border border-[var(--color-border-2)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)] outline-none focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20 transition-shadow"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-5 py-3 rounded-xl border-0 cursor-pointer hover:brightness-105 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <Icon name="briefcase" size={15} />
                  {submitting ? 'Signing in…' : 'Sign in to portal'}
                </button>
              </form>

              <div className="flex items-center gap-3 my-6">
                <div className="flex-1 h-px bg-[var(--color-border)]" />
                <span className="text-[11px] text-[var(--color-txt-3)] uppercase tracking-wider">New here</span>
                <div className="flex-1 h-px bg-[var(--color-border)]" />
              </div>

              {reqDone ? (
                <div
                  role="status"
                  className="rounded-xl border border-[var(--color-gold)]/30 bg-[var(--color-gold)]/10 p-3.5 text-[13px] leading-relaxed text-[var(--color-txt-1)]"
                >
                  Thanks — we’ve got your request. We’ll email you about advertiser access during the campus pilot.
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
                    className="w-full rounded-xl border border-[var(--color-border-2)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)] outline-none focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20 transition-shadow"
                  />
                  <input
                    type="text"
                    value={reqCompany}
                    onChange={(e) => setReqCompany(e.target.value)}
                    placeholder="Company (optional)"
                    aria-label="Company"
                    className="w-full rounded-xl border border-[var(--color-border-2)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)] outline-none focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20 transition-shadow"
                  />
                  <textarea
                    value={reqMessage}
                    onChange={(e) => setReqMessage(e.target.value)}
                    placeholder="What would you like to promote? (optional)"
                    aria-label="Message"
                    rows={3}
                    className="w-full rounded-xl border border-[var(--color-border-2)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)] outline-none focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20 transition-shadow resize-none"
                  />
                  <button
                    type="submit"
                    disabled={reqSubmitting}
                    className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-[var(--color-txt-0)] px-5 py-3 rounded-xl border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
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
                  className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-[var(--color-txt-0)] px-5 py-3 rounded-xl border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] cursor-pointer transition-colors"
                >
                  <Icon name="send" size={15} />
                  Request advertiser access
                </button>
              )}

              <p className="text-[12px] text-[var(--color-txt-3)] text-center mt-6 leading-relaxed">
                Looking for the student app?{' '}
                <Link to="/login" className="text-[var(--color-accent)] hover:underline">Sign in here</Link>.
              </p>
            </>
          )}
        </div>

        <p className="text-[11px] text-[var(--color-txt-3)] text-center">
          Advertiser accounts are invite-only during the campus pilot · Not an official Purdue product
        </p>
      </main>
    </div>
  )
}
