import { cloneElement, useEffect, useState, type ReactElement } from 'react'
import { Navigate } from 'react-router-dom'
import { getAdvertiserSession } from '../lib/advertiserApi'

type GuardState = {
  status: 'loading' | 'ok' | 'unauth'
  advertiser: unknown
}

// Route guard for the advertiser portal. Confirms an advertiser session via
// GET /api/advertiser/me (separate from the student AuthContext), then injects
// the advertiser profile into the wrapped page so it needn't refetch.
export default function RequireAdvertiser({
  children,
}: {
  children: ReactElement<{ advertiser?: unknown }>
}) {
  const [state, setState] = useState<GuardState>({ status: 'loading', advertiser: null })

  useEffect(() => {
    let active = true
    getAdvertiserSession()
      .then((advertiser) => {
        if (!active) return
        setState(advertiser ? { status: 'ok', advertiser } : { status: 'unauth', advertiser: null })
      })
      .catch(() => {
        if (active) setState({ status: 'unauth', advertiser: null })
      })
    return () => {
      active = false
    }
  }, [])

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-[var(--color-txt-2)] text-sm bg-[var(--color-bg-0)]">
        Loading…
      </div>
    )
  }

  if (state.status === 'unauth') {
    return <Navigate to="/advertise" replace />
  }

  return cloneElement(children, { advertiser: state.advertiser })
}
