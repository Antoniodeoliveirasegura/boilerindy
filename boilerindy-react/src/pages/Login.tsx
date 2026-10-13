import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth, type BackendSession } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import {
  authRequest,
  parseNextPath,
  registerSupabaseUser,
  resolvePostLoginPath,
  type ApiRequestError,
  type SignInResponse,
} from '../lib/authApi'
import { sendPasswordResetEmail, signInWithEmail, signInWithGoogle, supabase } from '../lib/supabase'
import BrandMark from '../components/BrandMark'
import Icon from '../components/Icons'
import SiteDisclaimer from '../components/SiteDisclaimer'
import SkipLink from '../components/SkipLink'
import StatusBanner from '../components/StatusBanner'
import PageTitle from '../components/PageTitle'

const asideFeatures = [
  ['user', 'Create an account with your email'],
  ['graduation', 'Link Purdue separately inside setup'],
  ['calendar', 'Import class data from sources you connect'],
  ['sparkles', 'Secure authentication powered by Supabase'],
]

type PendingCode = { email: string; flow: 'signin' | 'signup' }

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
  const [oauthSubmitting, setOauthSubmitting] = useState(false)
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
      'oauth-error': 'Google sign-in could not be completed. Please try again.',
      'sign-out-failed':
        'Sign-out could not reach the server, so this device may still be signed in. On a shared computer, reconnect, reload this page and sign out again.',
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
  // Set once the password checks out and the server has emailed a code.
  const [pendingCode, setPendingCode] = useState<PendingCode | null>(null)
  const [code, setCode] = useState('')
  // Off by default, like Remember me: students sign in on shared lab and
  // library computers, where a trusted device would skip the code for a month.
  const [trustDevice, setTrustDevice] = useState(false)
  const [resending, setResending] = useState(false)
  // Destinations come from the router's copy of this page's URL, never
  // window.location: the navigate that ends a sign-in replaces the address at
  // once, so window.location had already lost ?next by the time the session
  // re-rendered this page, and the redirect below sent every redirected
  // sign-in to /dashboard (or /setup).
  const search = searchParams.toString()
  // Set while a sign-in or sign-up on this page is finishing: that flow picks
  // the destination itself, so the redirect below must not race it.
  const finishing = useRef(false)

  useEffect(() => {
    if (loading || !user || finishing.current) return
    // Already signed in (e.g. the installed app opening on /login): skip the
    // setup screen when a schedule source is already connected.
    navigate(resolvePostLoginPath(search, onboarding), { replace: true })
  }, [loading, user, onboarding, navigate, search])

  function clearErrors() {
    setBanner('')
    setSuccessBanner('')
    setFieldErr({})
  }

  // Hands off to Supabase, which redirects the browser to Google and back to
  // /auth/callback. On success this page unmounts mid-flight, so the spinner is
  // only ever cleared on failure.
  async function handleGoogleSignIn() {
    clearErrors()
    setOauthSubmitting(true)
    try {
      // Only an explicit ?next survives the round-trip; without one the callback
      // resolves setup-vs-dashboard from the onboarding state it gets back.
      const next = searchParams.get('next')
      if (next) sessionStorage.setItem('postAuthNext', next)
      else sessionStorage.removeItem('postAuthNext')
      await signInWithGoogle()
    } catch (error) {
      sessionStorage.removeItem('postAuthNext')
      setBanner(error instanceof Error ? error.message : 'Google sign-in failed. Please try again.')
      setOauthSubmitting(false)
    }
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
        const registered = await registerSupabaseUser(email.trim(), password, name.trim(), rememberMe)
        if (registered.twoFactorRequired) {
          setPendingCode({ email: registered.email || email.trim(), flow: 'signup' })
          if (registered.codeSent === false) {
            setBanner('Your account is ready, but we could not send the code. Tap "Send a new code" in about 30 seconds.')
          }
          return
        }
        try {
          await signInWithEmail(email.trim(), password)
        } catch {
          /* Backend session from register is enough if client Supabase env is misconfigured */
        }
        finishing.current = true
        try {
          await establishSession()
        } catch (error) {
          finishing.current = false
          throw error
        }
        navigate(parseNextPath(search), { replace: true })
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

        const result = (data ?? {}) as SignInResponse
        if (result.twoFactorRequired) {
          setPendingCode({ email: result.email || email.trim(), flow: 'signin' })
          return
        }
        finishSignIn(result.session ?? null, 'signin')
      }
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Authentication failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // The backend session is authoritative: it set the session cookie AND
  // returned the full payload. Apply it directly so the app is usable after
  // a single round-trip - no client re-sign-in + refreshSession waterfall
  // (issue #111).
  function finishSignIn(signedIn: BackendSession | null, flow: PendingCode['flow']) {
    finishing.current = true
    applySession(signedIn)

    // Establish the client Supabase session in the background - only needed
    // for OAuth and silent re-hydration after a backend restart. Its
    // onAuthStateChange listener reconciles the context session. On failure,
    // clear a stale local session so it can't re-hydrate as another user,
    // but only when one is actually there: signOut() broadcasts SIGNED_OUT
    // with nothing to sign out of, and that tore down the backend session
    // applied above, bouncing a valid sign-in back to /login every time
    // Supabase was unreachable (issue #298).
    void signInWithEmail(email.trim(), password).catch(async () => {
      try {
        const {
          data: { session: stale },
        } = await supabase.auth.getSession()
        if (stale) await supabase.auth.signOut({ scope: 'local' })
      } catch {
        // No readable local session, so there is nothing to clear.
      }
    })

    navigate(
      flow === 'signup' ? parseNextPath(search) : resolvePostLoginPath(search, signedIn?.onboarding),
      { replace: true },
    )
  }

  function leaveCodeStep() {
    setPendingCode(null)
    setCode('')
    clearErrors()
  }

  async function handleVerifyCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!pendingCode) return
    clearErrors()
    if (!/^\d{6}$/.test(code)) {
      setFieldErr({ code: 'Enter the 6-digit code from the email.' })
      return
    }
    setSubmitting(true)
    try {
      const data = (await authRequest('/api/auth/sign-in/verify', {
        method: 'POST',
        body: JSON.stringify({ code, trustDevice }),
      })) as SignInResponse
      finishSignIn(data.session ?? null, pendingCode.flow)
    } catch (error) {
      closeCodeStepIfOver(error)
      setBanner(error instanceof Error ? error.message : 'Could not verify the code. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // The API flags `restart` when the pending sign-in is over (timed out, too
  // many codes, password changed): back to the password form, from verify or
  // from resend alike.
  function closeCodeStepIfOver(error: unknown) {
    const restart = Boolean(
      (error as ApiRequestError & { payload?: { error?: { restart?: boolean } } })?.payload?.error?.restart,
    )
    if (restart) {
      setPendingCode(null)
      setCode('')
    }
  }

  async function handleResendCode() {
    clearErrors()
    setResending(true)
    try {
      await authRequest('/api/auth/sign-in/resend', { method: 'POST' })
      setSuccessBanner('A new code is on the way.')
    } catch (error) {
      closeCodeStepIfOver(error)
      setBanner(error instanceof Error ? error.message : 'Could not send a new code.')
    } finally {
      setResending(false)
    }
  }

  const isSignup = tab === 'signup'
  // Field plates come from the shared .input; a failed field keeps an error edge.
  const fieldClass = (err?: string) => (err ? 'input border-[var(--color-error)] hover:border-[var(--color-error)]' : 'input')
  const labelClass = 'block mb-1.5 text-[13px] font-semibold text-[var(--color-txt-1)]'
  const errorClass = 'mt-1.5 text-[12.5px] font-medium text-[var(--color-error)]'
  // The Sign in / Create account switch: two pills in a stat track.
  const segmentClass = (active: boolean) =>
    `pill justify-center ${active ? 'pill-active' : 'border-transparent bg-transparent hover:bg-[var(--color-surface)]'}`
  const textLink = 'font-semibold text-[var(--color-accent)] hover:underline underline-offset-2'

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-1)] text-[var(--color-txt-2)] text-sm">
        <PageTitle>{forgotMode ? 'Reset your password' : isSignup ? 'Create your account' : 'Sign in'}</PageTitle>
        Loading…
      </div>
    )
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] bg-[var(--color-bg-1)] text-[var(--color-txt-0)]">
      <PageTitle>{forgotMode ? 'Reset your password' : isSignup ? 'Create your account' : 'Sign in'}</PageTitle>
      {/* ── Brand / value panel: a neutral ink panel ──
          The ink fills the whole column; the content inside sticks at one
          viewport tall, so a long form scrolls past it instead of opening
          dead bands between the brand, the copy and the stats. */}
      <SkipLink />
      <aside className="ink-panel rounded-none border-0 relative hidden lg:block">
        <div className="sticky top-0 flex h-screen min-h-fit flex-col justify-between gap-12 px-12 pt-8 pb-10 xl:px-16">
          <Link to="/" className="topbar-brand w-fit">
            <BrandMark surface="ink" size={32} />
            BoilerIndy
          </Link>

          <div className="max-w-[500px]">
            {/* The sign chip from Landing, on the lifted tile so it stands off the ink. */}
            <div className="ink-panel inline-flex items-center overflow-hidden rounded-[4px] bg-[var(--color-ink-lift-2)] font-display text-[13px] font-extrabold tracking-[0.02em]">
              <span className="route-badge size-[34px] rounded-none">
                <Icon name="graduation" size={18} />
              </span>
              <span className="pl-3 pr-3.5">Student app</span>
            </div>
            <h1 className="page-title mt-7 text-[var(--color-ink-txt)]">
              Your campus hub, all in one place.
            </h1>
            <p className="mt-5 max-w-[460px] text-[16px] leading-relaxed text-[var(--color-ink-dim)]">
              Sign up with your email and link your Purdue account later during setup to access your schedule and campus services.
            </p>
            {/* The steps as stops on one line: white route badges on a thin track. */}
            <ul className="relative mt-10 space-y-4 before:absolute before:bottom-4 before:left-[15px] before:top-4 before:w-0.5 before:bg-[var(--color-ink-dim)]/35 before:content-['']">
              {asideFeatures.map(([icon, text]) => (
                <li key={text} className="relative flex items-center gap-4">
                  <span className="route-badge">
                    <Icon name={icon} size={18} />
                  </span>
                  <span className="text-[14.5px] leading-snug text-[var(--color-ink-txt)]">{text}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid max-w-[400px] grid-cols-[auto_minmax(0,1fr)] border-t-4 border-[var(--color-ink-txt)]">
            <div className="pt-4 pr-6">
              <div className="font-display text-[30px] xl:text-[34px] font-extrabold leading-none tracking-[-0.03em] text-[var(--color-ink-txt)]">Free</div>
              <div className="mt-2 text-[13px] text-[var(--color-ink-dim)]">For all students</div>
            </div>
            <div className="border-l border-[var(--color-ink-edge)] pt-4 pl-6">
              <div className="font-display text-[30px] xl:text-[34px] font-extrabold leading-none tracking-[-0.03em] text-[var(--color-ink-txt)]">Secure</div>
              <div className="mt-2 text-[13px] text-[var(--color-ink-dim)]">Supabase auth</div>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Auth panel ──────────────────────────────────────────────────── */}
      <main id="main" tabIndex={-1} className="relative flex min-w-0 flex-col px-4 pt-3 sm:px-10 sm:pt-5 lg:pt-[26px] focus:outline-none">
        <div className="flex items-center justify-between">
          <Link
            to="/"
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
          <div className="mb-4 flex items-center gap-3 lg:hidden">
            <BrandMark size={30} />
            <span aria-hidden="true" className="h-5 w-px bg-[var(--color-border-3)]" />
            <span className="eyebrow bare">Student app</span>
          </div>

          <h1 className="page-title compact">
            {pendingCode ? 'Check your email' : forgotMode ? 'Reset your password' : isSignup ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="page-sub mb-6">
            {pendingCode
              ? `We sent a 6-digit code to ${pendingCode.email}. Enter it to ${pendingCode.flow === 'signup' ? 'confirm your email' : 'finish signing in'}.`
              : forgotMode
                ? 'Enter your account email and we will send you a reset link.'
                : isSignup
                  ? 'Create your account with Google or your email. Purdue linking comes after sign-up, in setup.'
                  : 'Sign in with Google or your email. Purdue linking comes after sign-up, in setup.'}
          </p>

          <div className={`mb-5 grid grid-cols-2 gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border-2)] bg-[var(--color-stat)] p-1 ${forgotMode || pendingCode ? 'hidden' : ''}`}>
            <button type="button" onClick={() => { setTab('signin'); clearErrors() }} className={segmentClass(!isSignup)}>
              Sign in
            </button>
            <button type="button" onClick={() => { setTab('signup'); clearErrors() }} className={segmentClass(isSignup)}>
              Create account
            </button>
          </div>

          {banner && (
            <StatusBanner tone="error" className="mb-4">
              {banner}
            </StatusBanner>
          )}

          {successBanner && (
            <StatusBanner tone="success" className="mb-4">
              {successBanner}
            </StatusBanner>
          )}

          {!forgotMode && !pendingCode && (
            <>
              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={oauthSubmitting || submitting}
                className="btn btn-secondary min-h-11 w-full"
              >
                <Icon name="google" size={18} />
                {oauthSubmitting ? 'Redirecting to Google…' : 'Continue with Google'}
              </button>

              <div className="my-5 flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-[var(--color-border-2)]" />
                <span className="eyebrow bare text-[var(--color-txt-3)]">or use your email</span>
                <span className="h-px flex-1 bg-[var(--color-border-2)]" />
              </div>
            </>
          )}

          {pendingCode ? (
            <form onSubmit={handleVerifyCode} className="space-y-4">
              <div>
                <label htmlFor="code" className={labelClass}>Verification code</label>
                <input
                  id="code"
                  className={`${fieldClass(fieldErr.code)} code`}
                  value={code}
                  onChange={(ev) => setCode(ev.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                />
                {fieldErr.code && <p className={errorClass}>{fieldErr.code}</p>}
              </div>
              <label className="flex cursor-pointer select-none items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={trustDevice}
                  onChange={(e) => setTrustDevice(e.target.checked)}
                  className="mt-px h-[18px] w-[18px] shrink-0 accent-[var(--color-txt-0)]"
                />
                <span className="text-[13.5px] leading-snug text-[var(--color-txt-1)]">Trust this device for 30 days (only on your own device)</span>
              </label>
              <button
                type="submit"
                disabled={submitting || code.length !== 6}
                className="btn btn-primary min-h-11 w-full"
              >
                <Icon name="check" size={16} />
                {submitting ? 'Verifying…' : 'Verify and continue'}
              </button>
              <div className="flex flex-wrap items-center justify-between gap-x-4">
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={resending}
                  className={`inline-flex min-h-11 items-center bg-transparent text-[13px] ${textLink} disabled:opacity-60`}
                >
                  {resending ? 'Sending…' : 'Send a new code'}
                </button>
                <button
                  type="button"
                  onClick={leaveCodeStep}
                  className="inline-flex min-h-11 items-center bg-transparent text-[13px] font-semibold text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]"
                >
                  Use a different account
                </button>
              </div>
            </form>
          ) : forgotMode ? (
            <form onSubmit={handleForgotSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className={labelClass}>Email address</label>
                <input id="email" type="email" className={fieldClass(fieldErr.email)} value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="you@example.com" autoComplete="email" />
                {fieldErr.email && <p className={errorClass}>{fieldErr.email}</p>}
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="btn btn-primary min-h-11 w-full"
              >
                <Icon name="mail" size={16} />
                {submitting ? 'Sending…' : 'Email me a reset link'}
              </button>
              <button
                type="button"
                onClick={() => { setForgotMode(false); clearErrors() }}
                className="btn btn-ghost min-h-11 w-full"
              >
                Back to sign in
              </button>
            </form>
          ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignup && (
              <div>
                <label htmlFor="name" className={labelClass}>Full name</label>
                <input id="name" className={fieldClass(fieldErr.name)} value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Your Name" autoComplete="name" />
                {fieldErr.name && <p className={errorClass}>{fieldErr.name}</p>}
              </div>
            )}

            <div>
              <label htmlFor="email" className={labelClass}>Email address</label>
              <input id="email" type="email" className={fieldClass(fieldErr.email)} value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="you@example.com" autoComplete="email" />
              {fieldErr.email && <p className={errorClass}>{fieldErr.email}</p>}
            </div>

            <div>
              <label htmlFor="password" className={labelClass}>Password</label>
              <div className="relative">
                <input id="password" type={pwVisible ? 'text' : 'password'} className={`${fieldClass(fieldErr.password)} pr-12`} value={password} onChange={(ev) => setPassword(ev.target.value)} placeholder="••••••••" autoComplete={isSignup ? 'new-password' : 'current-password'} />
                {/* A 36px plate with a 44px hit area (the before: box) that fills the field's height. */}
                <button type="button" onClick={() => setPwVisible((v) => !v)} className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-[var(--radius-md)] bg-transparent text-[var(--color-txt-2)] before:absolute before:-inset-1 before:content-[''] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)]">
                  <Icon name={pwVisible ? 'eyeOff' : 'eye'} size={17} />
                </button>
              </div>
              {fieldErr.password && <p className={errorClass}>{fieldErr.password}</p>}
            </div>

            {isSignup && (
              <div>
                <label htmlFor="confirm" className={labelClass}>Confirm password</label>
                <input id="confirm" type="password" className={fieldClass(fieldErr.confirm)} value={confirm} onChange={(ev) => setConfirm(ev.target.value)} placeholder="••••••••" autoComplete="new-password" />
                {fieldErr.confirm && <p className={errorClass}>{fieldErr.confirm}</p>}
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <label className="flex min-h-11 cursor-pointer select-none items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="h-[18px] w-[18px] shrink-0 accent-[var(--color-txt-0)]"
                />
                <span className="text-[13.5px] text-[var(--color-txt-1)]">Remember me</span>
              </label>
              {!isSignup && (
                <button
                  type="button"
                  onClick={() => { setForgotMode(true); clearErrors() }}
                  className={`inline-flex min-h-11 items-center bg-transparent text-[13px] ${textLink}`}
                >
                  Forgot password?
                </button>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="btn btn-primary min-h-11 w-full"
            >
              <Icon name={isSignup ? 'sparkles' : 'mail'} size={16} />
              {submitting ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'}
            </button>

            {isSignup && (
              <p className="text-[12px] leading-relaxed text-[var(--color-txt-3)]">
                By creating an account you agree to basic usage analytics that help improve
                BoilerIndy - stored in our own database, no third-party trackers, opt out anytime
                in Settings.{' '}
                <Link to="/privacy?from=signup" className={textLink}>
                  Privacy policy
                </Link>
                .
              </p>
            )}
          </form>
          )}

          <div className="mt-8 space-y-3 border-t border-[var(--color-border-2)] pt-5 text-[13px] leading-relaxed text-[var(--color-txt-2)]">
            <p className="flex items-start gap-2.5">
              <Icon name="plus" size={15} className="mt-[3px] text-[var(--color-txt-3)]" />
              <span>
                On your phone?{' '}
                <Link to="/install?from=signin" className={textLink}>Add BoilerIndy to your Home Screen</Link>{' '}
                for full screen and deadline reminders.
              </span>
            </p>
            <p className="flex items-start gap-2.5">
              <Icon name="briefcase" size={15} className="mt-[3px] text-[var(--color-txt-3)]" />
              <span>
                Want to advertise on BoilerIndy?{' '}
                <Link to="/advertise" className={textLink}>Advertiser sign in</Link>.
              </span>
            </p>
          </div>
        </div>

        <SiteDisclaimer note="Link your Purdue account later in setup" className="-mx-4 sm:-mx-10" rule />
      </main>
    </div>
  )
}
