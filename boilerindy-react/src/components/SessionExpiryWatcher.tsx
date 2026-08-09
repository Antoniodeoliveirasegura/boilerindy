import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
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
  const { session, establishSession } = useAuth()
  const location = useLocation()
  const [now, setNow] = useState(() => Date.now())
  const [extending, setExtending] = useState(false)
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
  const nextPath = encodeURIComponent(location.pathname + location.search)

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

  return (
    <div
      role="alert"
      className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-[3000] w-[calc(100%-2rem)] max-w-md rounded-2xl border border-[var(--color-gold)]/40 bg-[var(--color-surface)] shadow-[var(--shadow-md)] p-4"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-[var(--color-gold)]/15 text-[var(--color-gold)] flex items-center justify-center shrink-0">
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
              <Link
                to={`/login?next=${nextPath}&message=${encodeURIComponent('Your session expired. Please sign in again.')}`}
                className="btn btn-primary text-[12px] px-4 py-2"
              >
                Sign in again
              </Link>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleStaySignedIn}
                  disabled={extending}
                  className="btn btn-primary text-[12px] px-4 py-2 disabled:opacity-50"
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
