import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import Icon from '../components/Icons'

// Advertiser portal sign-in — a SEPARATE login from the student /login flow, for
// businesses and marketers who want to run ads on BoilerIndy. UI only for now:
// the form is stubbed (no backend auth wired yet) so the portal can be designed
// and reviewed before advertiser accounts exist server-side.

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

  // Stubbed until advertiser auth is built server-side. Keeps the form
  // interactive (and validates input) without pretending to authenticate.
  const handleSubmit = (e) => {
    e.preventDefault()
    if (!email.trim() || !password) {
      setNotice({ type: 'error', text: 'Enter your business email and password to continue.' })
      return
    }
    setNotice({
      type: 'info',
      text: 'Advertiser accounts are invite-only during our campus pilot. Request access below and we’ll email your credentials.',
    })
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

          <h2 className="text-[1.6rem] font-bold tracking-tight mb-1.5">Advertiser sign in</h2>
          <p className="text-[13px] text-[var(--color-txt-2)] mb-7">
            Manage your campaigns and placements on BoilerIndy.
          </p>

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
              className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-5 py-3 rounded-xl border-0 cursor-pointer hover:brightness-105 transition-all"
            >
              <Icon name="briefcase" size={15} />
              Sign in to portal
            </button>
          </form>

          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-[var(--color-border)]" />
            <span className="text-[11px] text-[var(--color-txt-3)] uppercase tracking-wider">New here</span>
            <div className="flex-1 h-px bg-[var(--color-border)]" />
          </div>

          <a
            href="mailto:partners@boilerindy.app?subject=Advertiser%20access%20request"
            className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-[var(--color-txt-0)] px-5 py-3 rounded-xl border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] no-underline transition-colors"
          >
            <Icon name="send" size={15} />
            Request advertiser access
          </a>

          <p className="text-[12px] text-[var(--color-txt-3)] text-center mt-6 leading-relaxed">
            Looking for the student app?{' '}
            <Link to="/login" className="text-[var(--color-accent)] hover:underline">Sign in here</Link>.
          </p>
        </div>

        <p className="text-[11px] text-[var(--color-txt-3)] text-center">
          Advertiser accounts are invite-only during the campus pilot · Not an official Purdue product
        </p>
      </main>
    </div>
  )
}
