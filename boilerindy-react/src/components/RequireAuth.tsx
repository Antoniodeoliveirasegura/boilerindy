import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../context/AuthContext'
import Icon from './Icons'
import PageTitle from './PageTitle'

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, sessionCheckFailed, establishSession } = useAuth()
  const location = useLocation()
  const [retrying, setRetrying] = useState(false)

  if (loading) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-[var(--color-txt-2)] text-sm">
        Loading…
      </div>
    )
  }

  // The session read got no answer (a server error, a restart, or no
  // connection), so the student may well still be signed in. Sending them to
  // the sign-in form here signed them out with no explanation; a retry keeps
  // them on the page they asked for.
  if (!user && sessionCheckFailed) {
    const retry = async () => {
      if (retrying) return
      setRetrying(true)
      try {
        await establishSession()
      } finally {
        setRetrying(false)
      }
    }
    return (
      <div className="page flex min-h-[50vh] flex-col justify-center">
        <PageTitle>Can’t reach BoilerIndy</PageTitle>
        <div className="page-measure">
          <h1 className="page-title">Can’t reach BoilerIndy right now</h1>
          <p className="page-sub">
            We could not check your sign-in. Check your connection, then try again.
          </p>
          <div className="mt-7">
            {/* Not disabled while retrying: a disabled button drops keyboard
                focus to the page, and the student would lose their place. */}
            <button type="button" onClick={retry} aria-busy={retrying} className="btn btn-primary">
              <Icon name="refresh" size={16} />
              {retrying ? 'Trying again…' : 'Try again'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }

  return children
}
