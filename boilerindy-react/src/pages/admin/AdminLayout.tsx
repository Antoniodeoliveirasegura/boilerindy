import { Suspense, useEffect, useRef } from 'react'
import { NavLink, Outlet, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import Icon from '../../components/Icons'
import PageLoader from '../../components/PageLoader'

const NAV = [
  { to: '/admin', end: true, label: 'Overview', icon: 'grid' },
  { to: '/admin/leads', label: 'Access requests', icon: 'users' },
  { to: '/admin/campaigns', label: 'Campaigns', icon: 'briefcase' },
  { to: '/admin/advertisers', label: 'Advertisers', icon: 'check' },
  { to: '/admin/reports', label: 'Reports', icon: 'flag' },
  { to: '/admin/photos', label: 'Photo review', icon: 'image' },
  { to: '/admin/deleted', label: 'Deleted content', icon: 'trash' },
]

export default function AdminLayout() {
  const { user, getDisplayName } = useAuth()
  const { pathname } = useLocation()
  const navRef = useRef<HTMLElement>(null)

  // Below lg the nav is one scrolling row: when the current page's link is
  // cut off, scroll the row just enough to show it (horizontally only; the
  // page itself does not move). The nav is the links' offsetParent.
  useEffect(() => {
    const nav = navRef.current
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return
    const gutter = 12
    const left = active.offsetLeft - gutter
    const right = active.offsetLeft + active.offsetWidth + gutter
    if (left < nav.scrollLeft) nav.scrollLeft = left
    else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth
  }, [pathname])

  return (
    <div className="page">
      <div className="flex flex-col lg:flex-row gap-5 lg:gap-8">
        {/* lg and up: a sidebar card with the nav as a column. Below lg the
            same card is compact: one header line, the nav as a single row
            that scrolls sideways under the card edge (its 6px of vertical
            padding keeps the focus ring inside the scroller), and the back
            link and email sharing the last line. */}
        <aside className="lg:w-60 shrink-0">
          <div className="card r-ink p-3 lg:sticky lg:top-20">
            <div className="flex items-center gap-3 px-1.5 pt-1 pb-3 mb-2 border-b border-[var(--color-border)]">
              <span className="route-badge">
                <Icon name="shield" size={18} />
              </span>
              <div className="min-w-0 max-lg:flex max-lg:items-baseline max-lg:gap-2.5">
                <div className="font-display font-bold text-[14px] leading-tight text-[var(--color-txt-0)] truncate max-lg:shrink-0">Admin console</div>
                <div className="text-[12px] text-[var(--color-txt-2)] mt-0.5 truncate max-lg:mt-0 max-lg:min-w-0">{getDisplayName()}</div>
              </div>
            </div>

            <nav
              ref={navRef}
              className="relative -mx-3 -my-1.5 flex gap-1 overflow-x-auto px-3 py-1.5 lg:m-0 lg:grid lg:grid-cols-1 lg:overflow-visible lg:p-0"
              aria-label="Admin navigation"
            >
              {NAV.map(({ to, end, label, icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  // The shell's drawer row (an ink plate with the amber edge when
                  // active), sized down for the console: it follows any change
                  // to .drawer-link in index.css.
                  className={({ isActive }) =>
                    `drawer-link gap-2.5 min-h-[44px] lg:min-h-[40px] px-3 text-[13.5px] leading-tight transition-colors max-lg:w-auto max-lg:shrink-0 max-lg:whitespace-nowrap ${isActive ? 'is-active' : ''}`
                  }
                >
                  <Icon name={icon} size={16} />
                  {label}
                </NavLink>
              ))}
            </nav>

            <div className="mt-2 pt-2 border-t border-[var(--color-border)] px-1.5 pb-1 max-lg:flex max-lg:items-center max-lg:justify-between max-lg:gap-3 max-lg:pb-0">
              <Link
                to="/dashboard"
                className="inline-flex items-center min-h-[36px] max-md:min-h-[44px] font-display font-bold text-[13px] text-[var(--color-txt-2)] hover:text-[var(--color-accent)] no-underline max-lg:shrink-0"
              >
                ← Back to student app
              </Link>
              {user?.email && (
                <div className="text-[12px] text-[var(--color-txt-3)] truncate max-lg:min-w-0">{user.email}</div>
              )}
            </div>
          </div>
        </aside>

        {/* AppLayout renders the page's <main> (issue #221); this is a plain column. */}
        <div className="flex-1 min-w-0">
          {/* Each admin tab is its own chunk. Loading here keeps the sidebar on
              screen; without it the app's outer loader replaced the whole console. */}
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
