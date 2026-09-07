import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth, type BackendSession } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { parseNextPath, registerSupabaseUser, resolvePostLoginPath } from '../lib/authApi'
import { sendPasswordResetEmail, signInWithEmail, supabase } from '../lib/supabase'
import Icon from '../components/Icons'
import SiteDisclaimer from '../components/SiteDisclaimer'

const asideFeatures = [
  ['user', 'Create an account with your email'],
  ['graduation', 'Link Purdue separately inside setup'],
  ['calendar', 'Import class data from sources you connect'],
  ['sparkles', 'Secure authentication powered by Supabase'],
]

export default function Login() {
  const { user, loading, onboarding, establishSession, applySession } = useAuth()
  const { dark, toggleTheme } = useTheme()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  // Seed the active tab from ?tab=signup so deep links (e.g. the privacy page's
  // context-aware "Back to sign up" link, issue #56) land on the signup tab.
  const [tab, setTab] = useState(() => (searchParams.get('tab') === 'signup' ? 'signup' : 'signin'))
  const [forgotMode, setForgotMode] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwVisible, setPwVisible] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Seed banners from the redirect URL once at mount. These arrive via a CAS
  // redirect, so reading them in the initializer (instead of a setState-in-effect)
  // is both correct and avoids the cascading-render lint warning.
  const [banner, setBanner] = useState(() => {
    const error = searchParams.get('error')
    if (!error) return ''
    const messages: Record<string, string> = {
      'cas-config': 'Purdue linking is not configured yet on the backend.',
      'missing-ticket': 'Purdue CAS did not return a ticket. Try again from setup.',
      'cas-validation': 'Purdue CAS could not validate the identity. Try again from setup.',
    }
    return messages[error] || 'Authentication could not be completed.'
  })
  const [successBanner, setSuccessBanner] = useState(() => {
    const message = searchParams.get('message')
    if (!message) return ''
    const allowed: Record<string, string> = {
      'password-reset-sent': 'If an account exists for that email, a reset link is on the way. Check your inbox.',
      'signed-out': 'You have been signed out.',
      'session-expired': 'Your session expired. Please sign in again.',
    }
    return allowed[message] || ''
  })
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({})

  useEffect(() => {
    if (loading) return
    if (user) {
      // Already signed in (e.g. the installed app opening on /login): skip the
      // setup screen when a schedule source is already connected.
      navigate(resolvePostLoginPath(window.location.search, onboarding), { replace: true })
    }
  }, [loading, user, onboarding, navigate])

  function clearErrors() {
    setBanner('')
    setSuccessBanner('')
    setFieldErr({})
  }

  async function handleForgotSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    clearErrors()
    if (!email.trim() || !email.includes('@')) {
      setFieldErr({ email: 'Please enter a valid email.' })
      return
    }
    setSubmitting(true)
    try {
      await sendPasswordResetEmail(email.trim())
      // Supabase succeeds for unknown emails too, so this never leaks accounts.
      setSuccessBanner('If an account exists for that email, a reset link is on the way. Check your inbox.')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Could not send a reset link. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    clearErrors()

    const nextErr: Record<string, string> = {}
    let valid = true

    if (tab === 'signup') {
      if (!name.trim()) {
        nextErr.name = 'Please enter your name.'
        valid = false
      }
      if (!email.trim() || !email.includes('@')) {
        nextErr.email = 'Please enter a valid email.'
        valid = false
      }
      if (password.length < 8) {
        nextErr.password = 'Password must be at least 8 characters.'
        valid = false
      }
      if (password !== confirm) {
        nextErr.confirm = 'Passwords do not match.'
        valid = false
      }
    } else {
      if (!email.trim() || !email.includes('@')) {
        nextErr.email = 'Please enter a valid email.'
        valid = false
      }
      if (!password) {
        nextErr.password = 'Please enter your password.'
        valid = false
      }
    }

    if (!valid) {
      setFieldErr(nextErr)
      return
    }

    setSubmitting(true)
    try {
      if (tab === 'signup') {
        // Clear any stale local Supabase session so a failed client sign-in
        // cannot leave another user's session on a shared device. Local scope
        // avoids a network round-trip.
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
        await registerSupabaseUser(email.trim(), password, name.trim(), rememberMe)
        try {
          await signInWithEmail(email.trim(), password)
        } catch {
          /* Backend session from register is enough if client Supabase env is misconfigured */
        }
        await establishSession()
        navigate(parseNextPath(window.location.search), { replace: true })
      } else {
        const response = await fetch('/api/auth/sign-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email: email.trim(), password, rememberMe }),
        })
        // A down/unreachable backend makes the proxy return an empty body, so
        // guard the parse instead of throwing a cryptic
        // "Unexpected end of JSON input" at the user.
        const data = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(
            data?.error?.message ||
              'Could not reach the server. Please try again in a moment.',
          )
        }

        // The backend sign-in is authoritative: it set the session cookie AND
        // returned the full payload. Apply it directly so the app is usable after
        // a single round-trip - no client re-sign-in + refreshSession waterfall
        // (issue #111).
        const signedIn = (data as { session?: BackendSession | null } | null)?.session ?? null
        applySession(signedIn)

        // Establish the client Supabase session in the background - only needed
        // for OAuth and silent re-hydration after a backend restart. Its
        // onAuthStateChange listener reconciles the context session. On failure,
        // clear any stale local session so it can't re-hydrate as another user.
        void signInWithEmail(email.trim(), password).catch(() => {
          void supabase.auth.signOut({ scope: 'local' }).catch(() => {})
        })

        navigate(resolvePostLoginPath(window.location.search, signedIn?.onboarding), { replace: true })
      }
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Authentication failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const isSignup = tab === 'signup'
  const inputBase =
    'w-full py-2.5 px-3.5 rounded-xl border border-[var(--color-border-2)] bg-[var(--color-surface)] text-[var(--color-txt-0)] text-sm outline-none transition-shadow focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20 placeholder:text-[var(--color-txt-3)]'

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-1)] text-[var(--color-txt-2)] text-sm">
        Loading…
      </div>
    )
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
            <Icon name="graduation" size={13} />
            Student app
          </div>
          <h1 className="text-[clamp(2rem,3.4vw,2.9rem)] font-bold tracking-[-0.02em] leading-tight text-[var(--color-gold-light)] mb-4">
            Your campus hub, all in one place.
          </h1>
          <p className="text-[15px] text-[var(--color-gold-light)]/70 leading-relaxed mb-8">
            Sign up with your email and link your Purdue account later during setup to access your schedule and campus services.
          </p>
          <ul className="list-none m-0 p-0 space-y-3.5">
            {asideFeatures.map(([icon, text]) => (
              <li key={text} className="flex items-center gap-3.5">
                <div className="w-9 h-9 shrink-0 rounded-lg bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/25 text-[var(--color-gold-light)] flex items-center justify-center">
                  <Icon name={icon} size={16} />
                </div>
                <span className="text-[13px] text-[var(--color-gold-light)]/80">{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center gap-6 text-[var(--color-gold-light)]/70">
          <div>
            <div className="text-[20px] font-bold text-[var(--color-gold-light)] leading-none">Free</div>
            <div className="text-[11px] mt-1">For all students</div>
          </div>
          <div className="w-px h-8 bg-[var(--color-gold)]/20" />
          <div>
            <div className="text-[20px] font-bold text-[var(--color-gold-light)] leading-none">Secure</div>
            <div className="text-[11px] mt-1">Supabase auth</div>
          </div>
        </div>
      </aside>

      {/* ── Auth panel ──────────────────────────────────────────────────── */}
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
          <div className="lg:hidden inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-gold)] bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/30 rounded-full px-3.5 py-1.5 mb-6 w-fit">
            <Icon name="graduation" size={13} />
            Student app
          </div>

          <h1 className="text-[1.6rem] font-bold tracking-tight mb-1.5">
            {forgotMode ? 'Reset your password' : isSignup ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="text-[13px] text-[var(--color-txt-2)] mb-6">
            {forgotMode
              ? 'Enter your account email and we will send you a reset link.'
              : isSignup
                ? 'Create your account to get started.'
                : 'Sign in to continue to BoilerIndy.'}
          </p>

          <div className={`flex bg-[var(--color-stat)] rounded-xl p-1 gap-1 mb-5 ${forgotMode ? 'hidden' : ''}`}>
            <button type="button" onClick={() => { setTab('signin'); clearErrors() }} className={`flex-1 py-2 rounded-lg text-[13px] font-medium border-0 cursor-pointer transition-all ${!isSignup ? 'bg-[var(--color-surface)] text-[var(--color-txt-0)] shadow-sm' : 'bg-transparent text-[var(--color-txt-1)]'}`}>
              Sign in
            </button>
            <button type="button" onClick={() => { setTab('signup'); clearErrors() }} className={`flex-1 py-2 rounded-lg text-[13px] font-medium border-0 cursor-pointer transition-all ${isSignup ? 'bg-[var(--color-surface)] text-[var(--color-txt-0)] shadow-sm' : 'bg-transparent text-[var(--color-txt-1)]'}`}>
              Create account
            </button>
          </div>

          {banner && (
            <div className="flex items-start gap-2.5 bg-[var(--color-error)]/10 border border-[var(--color-error)]/25 rounded-xl px-3.5 py-2.5 mb-4 text-[13px] text-[var(--color-error)]">
              <Icon name="close" size={16} className="shrink-0 mt-0.5" />
              <span>{banner}</span>
            </div>
          )}

          {successBanner && (
            <div className="flex items-start gap-2.5 bg-[var(--color-success)]/10 border border-[var(--color-success)]/25 rounded-xl px-3.5 py-2.5 mb-4 text-[13px] text-[var(--color-success)]">
              <Icon name="check" size={16} className="shrink-0 mt-0.5" />
              <span>{successBanner}</span>
            </div>
          )}

          {forgotMode ? (
            <form onSubmit={handleForgotSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-[12px] font-semibold text-[var(--color-txt-1)] mb-1.5">Email address</label>
                <input id="email" type="email" className={`${inputBase} ${fieldErr.email ? 'border-[var(--color-error)]' : ''}`} value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="you@example.com" autoComplete="email" />
                {fieldErr.email && <p className="text-[11px] text-[var(--color-error)] mt-1">{fieldErr.email}</p>}
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-5 py-3 rounded-xl border-0 cursor-pointer hover:brightness-105 transition-all disabled:opacity-60"
              >
                <Icon name="mail" size={16} />
                {submitting ? 'Sending…' : 'Email me a reset link'}
              </button>
              <button
                type="button"
                onClick={() => { setForgotMode(false); clearErrors() }}
                className="w-full text-[13px] text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)] bg-transparent border-0 cursor-pointer py-1"
              >
                Back to sign in
              </button>
            </form>
          ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignup && (
              <div>
                <label htmlFor="name" className="block text-[12px] font-semibold text-[var(--color-txt-1)] mb-1.5">Full name</label>
                <input id="name" className={`${inputBase} ${fieldErr.name ? 'border-[var(--color-error)]' : ''}`} value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Your Name" autoComplete="name" />
                {fieldErr.name && <p className="text-[11px] text-[var(--color-error)] mt-1">{fieldErr.name}</p>}
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-[12px] font-semibold text-[var(--color-txt-1)] mb-1.5">Email address</label>
              <input id="email" type="email" className={`${inputBase} ${fieldErr.email ? 'border-[var(--color-error)]' : ''}`} value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="you@example.com" autoComplete="email" />
              {fieldErr.email && <p className="text-[11px] text-[var(--color-error)] mt-1">{fieldErr.email}</p>}
            </div>

            <div>
              <label htmlFor="password" className="block text-[12px] font-semibold text-[var(--color-txt-1)] mb-1.5">Password</label>
              <div className="relative">
                <input id="password" type={pwVisible ? 'text' : 'password'} className={`${inputBase} pr-11 ${fieldErr.password ? 'border-[var(--color-error)]' : ''}`} value={password} onChange={(ev) => setPassword(ev.target.value)} placeholder="••••••••" autoComplete={isSignup ? 'new-password' : 'current-password'} />
                <button type="button" onClick={() => setPwVisible((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-md border-0 bg-transparent text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]">
                  <Icon name={pwVisible ? 'eyeOff' : 'eye'} size={16} />
                </button>
              </div>
              {fieldErr.password && <p className="text-[11px] text-[var(--color-error)] mt-1">{fieldErr.password}</p>}
            </div>

            {isSignup && (
              <div>
                <label htmlFor="confirm" className="block text-[12px] font-semibold text-[var(--color-txt-1)] mb-1.5">Confirm password</label>
                <input id="confirm" type="password" className={`${inputBase} ${fieldErr.confirm ? 'border-[var(--color-error)]' : ''}`} value={confirm} onChange={(ev) => setConfirm(ev.target.value)} placeholder="••••••••" autoComplete="new-password" />
                {fieldErr.confirm && <p className="text-[11px] text-[var(--color-error)] mt-1">{fieldErr.confirm}</p>}
              </div>
            )}

            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--color-border-2)] accent-[var(--color-gold)]"
                />
                <span className="text-[13px] text-[var(--color-txt-1)]">Remember me</span>
              </label>
              {!isSignup && (
                <button
                  type="button"
                  onClick={() => { setForgotMode(true); clearErrors() }}
                  className="text-[13px] text-[var(--color-accent)] hover:underline"
                >
                  Forgot password?
                </button>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-5 py-3 rounded-xl border-0 cursor-pointer hover:brightness-105 transition-all disabled:opacity-60"
            >
              <Icon name={isSignup ? 'sparkles' : 'mail'} size={16} />
              {submitting ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'}
            </button>

            {isSignup && (
              <p className="text-[11px] text-[var(--color-txt-3)] leading-relaxed">
                By creating an account you agree to basic usage analytics that help improve
                BoilerIndy - stored in our own database, no third-party trackers, opt out anytime
                in Settings.{' '}
                <Link to="/privacy?from=signup" className="text-[var(--color-accent)] hover:underline">
                  Privacy policy
                </Link>
                .
              </p>
            )}
          </form>
          )}

          <p className="text-[12px] text-[var(--color-txt-3)] text-center mt-6 leading-relaxed">
            On your phone?{' '}
            <Link to="/install" className="text-[var(--color-accent)] hover:underline">Add BoilerIndy to your Home Screen</Link>{' '}
            for full screen and deadline reminders.
          </p>
          <p className="text-[12px] text-[var(--color-txt-3)] text-center mt-6 leading-relaxed">
            Want to advertise on BoilerIndy?{' '}
            <Link to="/advertise" className="text-[var(--color-accent)] hover:underline">Advertiser sign in</Link>.
          </p>
        </div>

        <SiteDisclaimer note="Link your Purdue account later in setup" />
      </main>
    </div>
  )
}
