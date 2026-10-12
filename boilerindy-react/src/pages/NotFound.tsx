import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { reportBreadcrumb } from '../lib/errorReporting'
import PageTitle from '../components/PageTitle'
import Icon from '../components/Icons'

// Catch-all page for URLs the router does not know (issues #245, #222). It
// used to be a blank screen with no way onward; it now sits inside
// PublicLayout so the disclaimer footer renders, and links home plus to sign
// in or, for a signed-in visitor, to the dashboard.
//
// The miss is left as a navigation breadcrumb, never an error, so broken
// inbound links show up in the trail of later Sentry events. It goes through
// lib/errorReporting rather than Sentry directly: Sentry starts after first
// paint, so on a direct landing this page renders before init, when
// Sentry.addBreadcrumb would drop it. Without a DSN nothing is ever sent.
export default function NotFound() {
  const { pathname } = useLocation()
  const { user, loading } = useAuth()

  useEffect(() => {
    reportBreadcrumb({ category: 'navigation', message: 'not-found', data: { path: pathname } })
  }, [pathname])

  return (
    <div className="page flex flex-1 flex-col justify-center pb-16 md:pb-24" data-testid="not-found-page">
      <PageTitle>Page not found</PageTitle>
      <div className="page-measure">
        {/* Signage: a station board reading "Not in service" over a line that
            ends short of its stop. Decorative; the heading and copy below
            carry the message. */}
        <div aria-hidden="true" className="ink-panel r-ink px-5 pb-6 pt-5 sm:px-7 sm:pb-8 sm:pt-6">
          <div className="flex items-center justify-between gap-3">
            <span className="plate">Not in service</span>
            <span className="code">404</span>
          </div>
          <div className="relative mt-8 h-[26px]">
            <span className="absolute left-0 top-1/2 h-1.5 w-[58%] -translate-y-1/2 rounded-[3px] bg-[var(--route)]" />
            <span className="absolute left-[58%] right-9 top-1/2 -translate-y-1/2 border-t-[3px] border-dashed border-[var(--color-ink-dim)]" />
            <span className="absolute left-0 top-1/2 size-[22px] -translate-y-1/2 rounded-full border-[5px] border-[var(--route)] bg-[var(--color-ink-lift)]" />
            <span className="absolute left-[58%] top-1/2 size-[26px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[6px] border-[var(--route)] bg-[var(--color-ink-lift)]" />
            <span className="route-badge sm absolute right-0 top-1/2 -translate-y-1/2 bg-[var(--color-ink-lift-2)] text-[var(--color-ink-dim)] shadow-[inset_0_0_0_1px_var(--color-ink-edge)]">
              <Icon name="close" />
            </span>
          </div>
        </div>

        <h1 className="page-title mt-8">Page not found</h1>
        <p className="page-sub">That link is wrong or the page moved.</p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Link to="/" className="btn btn-primary">
            <Icon name="home" size={16} />
            Go to the home page
          </Link>
          {/* Hold the second link until the session check settles so a signed-in
              visitor never sees "Sign in" flash first. */}
          {loading ? null : user ? (
            <Link to="/dashboard" className="btn btn-secondary">
              Go to your dashboard
            </Link>
          ) : (
            <Link to="/login" className="btn btn-secondary">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
