import { NavLink, Outlet, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import Icon from '../../components/Icons'

const NAV = [
  { to: '/admin', end: true, label: 'Overview', icon: 'grid' },
  { to: '/admin/leads', label: 'Access requests', icon: 'users' },
  { to: '/admin/campaigns', label: 'Campaigns', icon: 'briefcase' },
  { to: '/admin/advertisers', label: 'Advertisers', icon: 'check' },
  { to: '/admin/reports', label: 'Reports', icon: 'flag' },
  { to: '/admin/deleted', label: 'Deleted content', icon: 'trash' },
]

export default function AdminLayout() {
  const { user, getDisplayName } = useAuth()

  return (
    <div className="page pb-10">
      <div className="flex flex-col lg:flex-row gap-5 lg:gap-8">
        <aside className="lg:w-60 shrink-0">
          <div className="card r-ink p-3 lg:sticky lg:top-20">
            <div className="flex items-center gap-3 px-1.5 pt-1 pb-3 mb-2 border-b border-[var(--color-border)]">
              <span className="route-badge">
                <Icon name="shield" size={18} />
              </span>
              <div className="min-w-0">
                <div className="font-display font-bold text-[14px] leading-tight text-[var(--color-txt-0)] truncate">Admin console</div>
                <div className="text-[12px] text-[var(--color-txt-2)] mt-0.5 truncate">{getDisplayName()}</div>
              </div>
            </div>

            <nav className="grid grid-cols-2 gap-1 lg:grid-cols-1" aria-label="Admin navigation">
              {NAV.map(({ to, end, label, icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  // The shell's drawer row (an ink plate with the amber edge when
                  // active), sized down for the console: it follows any change
                  // to .drawer-link in index.css.
                  className={({ isActive }) =>
                    `drawer-link gap-2.5 min-h-[44px] lg:min-h-[40px] px-3 text-[13.5px] leading-tight transition-colors ${isActive ? 'is-active' : ''}`
                  }
                >
                  <Icon name={icon} size={16} />
                  {label}
                </NavLink>
              ))}
            </nav>

            <div className="mt-2 pt-2 border-t border-[var(--color-border)] px-1.5 pb-1">
              <Link
                to="/dashboard"
                className="inline-flex items-center min-h-[36px] max-md:min-h-[44px] font-display font-bold text-[13px] text-[var(--color-txt-2)] hover:text-[var(--color-accent)] no-underline"
              >
                ← Back to student app
              </Link>
              {user?.email && (
                <div className="text-[12px] text-[var(--color-txt-3)] truncate">{user.email}</div>
              )}
            </div>
          </div>
        </aside>

        {/* AppLayout renders the page's <main> (issue #221); this is a plain column. */}
        <div className="flex-1 min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
