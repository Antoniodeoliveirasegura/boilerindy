import { Link, Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../context/AuthContext'
import Icon from './Icons'
import PageTitle from './PageTitle'

export default function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-[var(--color-txt-2)] text-[14px]">
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
      <div className="page">
        <PageTitle>Access denied</PageTitle>
        <div className="min-h-[60vh] flex items-center justify-center">
          <div className="card r-ink max-w-md w-full p-6 sm:p-8">
            <span className="route-badge lg mb-5">
              <Icon name="lock" size={22} />
            </span>
            <h1 className="page-title compact mb-2">Access denied</h1>
            <p className="text-[14px] text-[var(--color-txt-2)] mb-6 leading-relaxed">
              You don&apos;t have permission to view the admin console. If you need access, ask through{' '}
              <Link to="/support" className="prose-link">
                support
              </Link>
              .
            </p>
            <Link to="/dashboard" className="btn btn-primary no-underline">
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return children
}
