import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import { useAuth } from '../context/AuthContext'

// Catch-all page for URLs the router does not know (issues #245, #222). It
// used to be a blank screen with no way onward; it now sits inside
// PublicLayout so the disclaimer footer renders, and links home plus to sign
// in or, for a signed-in visitor, to the dashboard.
//
// The miss is left as a Sentry breadcrumb, never an error, so broken inbound
// links show up next to real crashes. addBreadcrumb is a no-op until
// Sentry.init has run, so this sends nothing without a DSN.
export default function NotFound() {
  const { pathname } = useLocation()
  const { user, loading } = useAuth()

  useEffect(() => {
    Sentry.addBreadcrumb({ category: 'navigation', message: 'not-found', data: { path: pathname } })
  }, [pathname])

  return (
    <div className="flex-1 bg-[var(--color-bg-1)] px-6 py-12" data-testid="not-found-page">
      <div className="max-w-[720px] mx-auto">
        <h1 className="text-3xl font-bold text-[var(--color-txt-0)] mt-4 mb-2">Page not found</h1>
        <p className="text-[14px] leading-relaxed text-[var(--color-txt-1)] mb-6">
          That link is wrong or the page moved.
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Link to="/" className="text-[13px] text-[var(--color-accent)] hover:underline">
            Go to the home page
          </Link>
          {/* Hold the second link until the session check settles so a signed-in
              visitor never sees "Sign in" flash first. */}
          {loading ? null : user ? (
            <Link to="/dashboard" className="text-[13px] text-[var(--color-accent)] hover:underline">
              Go to your dashboard
            </Link>
          ) : (
            <Link to="/login" className="text-[13px] text-[var(--color-accent)] hover:underline">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
