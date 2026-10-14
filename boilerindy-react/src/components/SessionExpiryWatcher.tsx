import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import Icon from './Icons'

const WARN_BEFORE_MS = 10 * 60 * 1000
const CHECK_INTERVAL_MS = 30 * 1000
const DISMISS_FOR_MS = 5 * 60 * 1000

/**
 * Warns shortly before the auth session expires and offers one-click
 * recovery (issue #23). "Stay signed in" works because the backend uses
 * rolling sessions - any authenticated request resets the cookie clock.
 */
export default function SessionExpiryWatcher() {
  const { session, establishSession, refreshSession } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [now, setNow] = useState(() => Date.now())
  const [extending, setExtending] = useState(false)
  const [checking, setChecking] = useState(false)
  const [dismissedUntil, setDismissedUntil] = useState(0)

  const expiresAtMs = session?.expiresAt
    ? new Date(session.expiresAt as string).getTime()
    : null

  useEffect(() => {
    if (!expiresAtMs) return undefined
    const id = setInterval(() => setNow(Date.now()), CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [expiresAtMs])

  if (!expiresAtMs || Number.isNaN(expiresAtMs)) return null

  const msLeft = expiresAtMs - now
  if (msLeft > WARN_BEFORE_MS) return null

  const expired = msLeft <= 0
  if (!expired && now < dismissedUntil) return null

  const minutesLeft = Math.max(1, Math.ceil(msLeft / 60000))

  const handleStaySignedIn = async () => {
    setExtending(true)
    try {
      // Recover via establishSession, not the cheap refreshSession (issue #149):
      // if the cookie has already lapsed, only re-minting it from the Supabase
      // token brings the session back. A plain /api/session re-read cannot.
      await establishSession()
      setNow(Date.now())
    } finally {
      setExtending(false)
    }
  }

  // A plain link to /login bounced straight back here: the context still held
  // the stale session, so Login saw a user and returned to `next`. Re-read the
  // session first. If the server still has one, its fresh expiresAt clears the
  // alert; if not, refreshSession has cleared the context and Login shows its
  // form with its 'session-expired' notice. Replace, as RequireAuth and the
  // 401 redirect in authRequest do.
  const handleSignInAgain = async () => {
    const nextPath = encodeURIComponent(location.pathname + location.search)
    setChecking(true)
    try {
      const fresh = await refreshSession()
      if (fresh) {
        setNow(Date.now())
        return
      }
      navigate(`/login?next=${nextPath}&message=session-expired`, { replace: true })
    } finally {
      setChecking(false)
    }
  }

  // On phones the bottom offset clears the assistant button (76px up over the
  // tab bar, 56px tall, plus an 8px gap), as UpdateToast's does (issue #249).
  // At 80px up the warning sat on the button, so a tap on it did nothing. It
  // layers between the assistant's backdrop (z-40) and its panel (z-50): over
  // the page and the tab bar, but under the open panel, whose input row it
  // used to cover on phones and tablets. UpdateToast shares the slot at a
  // higher z, so while it shows it sets --update-toast-lift and the warning
  // stacks above it instead of sitting under it with its buttons covered.
  return (
    <div
      role="alert"
      className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+140px+var(--update-toast-lift,0px))] md:bottom-[calc(1.5rem+var(--update-toast-lift,0px))] left-1/2 -translate-x-1/2 z-[45] w-[calc(100%-2rem)] max-w-md rounded-2xl border border-[var(--color-gold)]/40 bg-[var(--color-surface)] shadow-[var(--shadow-md)] p-4"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-[var(--color-gold)]/15 text-[var(--color-gold-muted)] flex items-center justify-center shrink-0">
          <Icon name="clock" size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-[var(--color-txt-0)]">
            {expired ? 'Your session has expired' : `Your session expires in about ${minutesLeft} min`}
          </p>
          <p className="text-[12px] text-[var(--color-txt-2)] mt-0.5 leading-relaxed">
            {expired
              ? 'Sign in again to continue - unsaved drafts on this device are kept.'
              : 'Extend it now so you don’t lose your place.'}
          </p>
          <div className="flex items-center gap-2 mt-3">
            {expired ? (
              <button
                type="button"
                onClick={handleSignInAgain}
                disabled={checking}
                className="btn btn-primary text-[12px] px-4 py-2"
              >
                Sign in again
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleStaySignedIn}
                  disabled={extending}
                  className="btn btn-primary text-[12px] px-4 py-2"
                >
                  {extending ? 'Extending…' : 'Stay signed in'}
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedUntil(Date.now() + DISMISS_FOR_MS)}
                  className="btn btn-secondary text-[12px] px-4 py-2"
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
