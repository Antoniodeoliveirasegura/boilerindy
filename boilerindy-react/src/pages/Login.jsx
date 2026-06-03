import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { parseNextPath, registerSupabaseUser } from '../lib/authApi'
import { signInWithEmail } from '../lib/supabase'
import Icon from '../components/Icons'

const asideFeatures = [
  ['user', 'Create an account with your email'],
  ['graduation', 'Link Purdue separately inside setup'],
  ['calendar', 'Import class data from sources you connect'],
  ['sparkles', 'Secure authentication powered by Supabase'],
]

export default function Login() {
  const { user, loading, refreshSession } = useAuth()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const [tab, setTab] = useState('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwVisible, setPwVisible] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [banner, setBanner] = useState('')
  const [successBanner, setSuccessBanner] = useState('')
  const [fieldErr, setFieldErr] = useState({})

  useEffect(() => {
    const error = searchParams.get('error')
    const message = searchParams.get('message')
    
    if (message) {
      setSuccessBanner(message)
    }
    
    if (!error) return
    const messages = {
      'cas-config': 'Purdue linking is not configured yet on the backend.',
      'missing-ticket': 'Purdue CAS did not return a ticket. Try again from setup.',
      'cas-validation': 'Purdue CAS could not validate the identity. Try again from setup.',
    }
    setBanner(messages[error] || 'Authentication could not be completed.')
  }, [searchParams])

  useEffect(() => {
    if (loading) return
    if (user) {
      navigate(parseNextPath(window.location.search), { replace: true })
    }
  }, [loading, user, navigate])

  function clearErrors() {
    setBanner('')
    setSuccessBanner('')
    setFieldErr({})
  }

  async function handleSubmit(e) {
    e.preventDefault()
    clearErrors()

    const nextErr = {}
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
        await registerSupabaseUser(email.trim(), password, name.trim(), rememberMe)
        try {
          await signInWithEmail(email.trim(), password)
        } catch {
          /* Backend session from register is enough if client Supabase env is misconfigured */
        }
        await refreshSession()
        navigate(parseNextPath(window.location.search), { replace: true })
      } else {
        const response = await fetch('/api/auth/sign-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email: email.trim(), password, rememberMe }),
        })
        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error?.message || 'Invalid email or password.')
        }

        // Also sign in on the client Supabase (non-blocking — only needed for OAuth features)
        try { await signInWithEmail(email.trim(), password) } catch { /* ok */ }

        await refreshSession()
        navigate(parseNextPath(window.location.search), { replace: true })
      }
    } catch (error) {
      setBanner(error.message || 'Authentication failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const isSignup = tab === 'signup'
  const inputBase =
    'w-full py-2.5 px-3.5 rounded-lg border border-[var(--color-border-2)] bg-[var(--color-bg-2)] text-[var(--color-txt-0)] text-sm outline-none transition-shadow focus:border-[var(--color-gold)] focus:shadow-[var(--shadow-glow)] placeholder:text-[var(--color-txt-3)]'

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-1)] text-[var(--color-txt-2)] text-sm">
        Loading…
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--color-bg-1)] text-[var(--color-txt-0)]">
      <div className="flex-1 grid lg:grid-cols-2 min-h-[100vh]">
        <aside className="hidden lg:flex flex-col relative overflow-hidden p-10 bg-gradient-to-br from-[var(--color-gold-dark)] via-[#5c3a00] to-[#2a1800] dark:from-[#1e1000] dark:via-[#2e1800] dark:to-[#1a0e00]">
          <div className="absolute -top-[20%] -right-[20%] w-[400px] h-[400px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(207,185,145,0.18) 0%, transparent 70%)' }} />
          <div className="absolute -bottom-[10%] -left-[10%] w-[300px] h-[300px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(207,185,145,0.1) 0%, transparent 70%)' }} />
          <div className="relative flex items-center gap-2.5 mb-auto">
            <span className="bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2.5 py-1 rounded-md tracking-wide">IA</span>
            <span className="text-[15px] font-semibold text-[var(--color-gold)]">IndyAssist</span>
          </div>
          <div className="relative my-auto max-w-[360px]">
            <h2 className="text-[clamp(1.5rem,2.5vw,2rem)] font-bold tracking-tight text-[var(--color-gold)] leading-tight mb-3">
              Your campus hub,
              <br />
              all in one place.
            </h2>
            <p className="text-sm text-[var(--color-gold)]/65 leading-relaxed">
              Sign up with your email and link your Purdue account later during setup to access your schedule and campus services.
            </p>
          </div>
          <div className="relative flex flex-col gap-2.5 mt-auto">
            {asideFeatures.map(([icon, text]) => (
              <div key={text} className="flex items-center gap-3 text-[13px] text-[var(--color-gold)]/75">
                <div className="w-8 h-8 rounded-lg bg-[var(--color-gold)]/12 border border-[var(--color-gold)]/15 flex items-center justify-center text-[var(--color-gold)] shrink-0">
                  <Icon name={icon} size={15} />
                </div>
                {text}
              </div>
            ))}
          </div>
        </aside>

        <main className="flex flex-col items-center justify-center px-6 py-12 relative">
          <div className="absolute top-5 right-5 flex gap-2 items-center">
            <Link to="/" className="text-[13px] text-[var(--color-txt-1)] px-3.5 py-1.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-2)] no-underline inline-flex items-center gap-1.5">
              <span className="inline-flex rotate-[225deg]"><Icon name="arrowUpRight" size={14} /></span>
              Back
            </Link>
          </div>

          <div className="w-full max-w-[420px]">
            <div className="mb-7">
              <div className="flex items-center gap-2 mb-5">
                <span className="bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2.5 py-1 rounded-md tracking-wide">IA</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-[var(--color-txt-0)] mb-1">
                {isSignup ? 'Create your account' : 'Welcome back'}
              </h1>
              <p className="text-[13px] text-[var(--color-txt-1)]">
                {isSignup ? 'Create your account to get started.' : 'Sign in to continue to IndyAssist.'}
              </p>
            </div>

            <div className="flex bg-[var(--color-bg-2)] rounded-[10px] p-1 gap-1 mb-5">
              <button type="button" onClick={() => { setTab('signin'); clearErrors() }} className={`flex-1 py-2 rounded-lg text-[13px] font-medium border-0 cursor-pointer transition-all ${!isSignup ? 'bg-[var(--color-surface)] text-[var(--color-txt-0)] shadow-sm' : 'bg-transparent text-[var(--color-txt-1)]'}`}>
                Sign in
              </button>
              <button type="button" onClick={() => { setTab('signup'); clearErrors() }} className={`flex-1 py-2 rounded-lg text-[13px] font-medium border-0 cursor-pointer transition-all ${isSignup ? 'bg-[var(--color-surface)] text-[var(--color-txt-0)] shadow-sm' : 'bg-transparent text-[var(--color-txt-1)]'}`}>
                Create account
              </button>
            </div>

            {banner && (
              <div className="flex items-start gap-2.5 bg-[var(--color-error)]/10 border border-[var(--color-error)]/25 rounded-lg px-3.5 py-2.5 mb-4 text-[13px] text-[var(--color-error)]">
                <Icon name="close" size={16} className="shrink-0 mt-0.5" />
                <span>{banner}</span>
              </div>
            )}

            {successBanner && (
              <div className="flex items-start gap-2.5 bg-[var(--color-success)]/10 border border-[var(--color-success)]/25 rounded-lg px-3.5 py-2.5 mb-4 text-[13px] text-[var(--color-success)]">
                <Icon name="check" size={16} className="shrink-0 mt-0.5" />
                <span>{successBanner}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="card p-6">
              {isSignup && (
                <div className="mb-4">
                  <label htmlFor="name" className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">Full name</label>
                  <input id="name" className={`${inputBase} ${fieldErr.name ? 'border-[var(--color-error)]' : ''}`} value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Your Name" autoComplete="name" />
                  {fieldErr.name && <p className="text-[11px] text-[var(--color-error)] mt-1">{fieldErr.name}</p>}
                </div>
              )}

              <div className="mb-4">
                <label htmlFor="email" className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">Email address</label>
                <input id="email" type="email" className={`${inputBase} ${fieldErr.email ? 'border-[var(--color-error)]' : ''}`} value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="you@example.com" autoComplete="email" />
                {fieldErr.email && <p className="text-[11px] text-[var(--color-error)] mt-1">{fieldErr.email}</p>}
              </div>

              <div className="mb-4">
                <label htmlFor="password" className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">Password</label>
                <div className="relative">
                  <input id="password" type={pwVisible ? 'text' : 'password'} className={`${inputBase} pr-11 ${fieldErr.password ? 'border-[var(--color-error)]' : ''}`} value={password} onChange={(ev) => setPassword(ev.target.value)} placeholder="••••••••" autoComplete={isSignup ? 'new-password' : 'current-password'} />
                  <button type="button" onClick={() => setPwVisible((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-md border-0 bg-transparent text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]">
                    <Icon name={pwVisible ? 'eyeOff' : 'eye'} size={16} />
                  </button>
                </div>
                {fieldErr.password && <p className="text-[11px] text-[var(--color-error)] mt-1">{fieldErr.password}</p>}
              </div>

              {isSignup && (
                <div className="mb-5">
                  <label htmlFor="confirm" className="block text-[12px] font-medium text-[var(--color-txt-1)] mb-1.5">Confirm password</label>
                  <input id="confirm" type="password" className={`${inputBase} ${fieldErr.confirm ? 'border-[var(--color-error)]' : ''}`} value={confirm} onChange={(ev) => setConfirm(ev.target.value)} placeholder="••••••••" autoComplete="new-password" />
                  {fieldErr.confirm && <p className="text-[11px] text-[var(--color-error)] mt-1">{fieldErr.confirm}</p>}
                </div>
              )}

              <div className="flex items-center justify-between mb-5">
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
                  <button type="button" className="text-[13px] text-[var(--color-gold)] hover:underline">
                    Forgot password?
                  </button>
                )}
              </div>

              <button type="submit" disabled={submitting} className="w-full btn btn-primary text-[14px] px-5 py-3 justify-center disabled:opacity-60">
                <Icon name={isSignup ? 'sparkles' : 'mail'} size={16} />
                {submitting ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'}
              </button>
            </form>
          </div>
        </main>
      </div>
    </div>
  )
}
