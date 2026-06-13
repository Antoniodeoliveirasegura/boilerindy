import { Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import Icon from './Icons'

export default function RequireAdmin({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-[var(--color-txt-2)] text-sm">
        Loading…
      </div>
    )
  }

  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }

  if (!user.isAdmin) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-6">
        <div className="max-w-md w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 w-12 h-12 rounded-xl bg-[var(--color-bg-2)] flex items-center justify-center text-[var(--color-txt-2)]">
            <Icon name="lock" size={22} />
          </div>
          <h1 className="text-lg font-semibold text-[var(--color-txt-0)] mb-2">Access denied</h1>
          <p className="text-[13px] text-[var(--color-txt-2)] mb-6 leading-relaxed">
            You don&apos;t have permission to view the admin console. Contact a platform owner if you need access.
          </p>
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center rounded-xl bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[13px] font-semibold px-4 py-2.5 no-underline hover:opacity-90"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    )
  }

  return children
}
