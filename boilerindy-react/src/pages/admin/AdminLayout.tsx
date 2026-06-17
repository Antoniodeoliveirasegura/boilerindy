import { NavLink, Outlet, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import Icon from '../../components/Icons'

const NAV = [
  { to: '/admin', end: true, label: 'Overview', icon: 'grid' },
  { to: '/admin/leads', label: 'Access requests', icon: 'users' },
  { to: '/admin/campaigns', label: 'Campaigns', icon: 'briefcase' },
  { to: '/admin/advertisers', label: 'Advertisers', icon: 'check' },
  { to: '/admin/deleted', label: 'Deleted content', icon: 'trash' },
]

export default function AdminLayout() {
  const { user, getDisplayName } = useAuth()

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[var(--color-bg-0)]">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-6 lg:py-8">
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
          <aside className="lg:w-64 shrink-0">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 lg:sticky lg:top-20">
              <div className="flex items-center gap-3 px-2 pb-4 mb-2 border-b border-[var(--color-border)]">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center text-[var(--color-gold-dark)]">
                  <Icon name="shield" size={18} />
                </div>
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-[var(--color-txt-0)] truncate">Admin console</div>
                  <div className="text-[11px] text-[var(--color-txt-2)] truncate">{getDisplayName()}</div>
                </div>
              </div>

              <nav className="space-y-1" aria-label="Admin navigation">
                {NAV.map(({ to, end, label, icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] no-underline transition-colors ${
                        isActive
                          ? 'bg-[var(--color-gold)]/20 text-[var(--color-gold-dark)] font-medium border border-[var(--color-gold)]/30'
                          : 'text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] border border-transparent'
                      }`
                    }
                  >
                    <Icon name={icon} size={16} />
                    {label}
                  </NavLink>
                ))}
              </nav>

              <div className="mt-4 pt-4 border-t border-[var(--color-border)] px-2">
                <Link
                  to="/dashboard"
                  className="text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-accent)] no-underline"
                >
                  ← Back to student app
                </Link>
                {user?.email && (
                  <div className="text-[11px] text-[var(--color-txt-3)] mt-2 truncate">{user.email}</div>
                )}
              </div>
            </div>
          </aside>

          <main className="flex-1 min-w-0">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}
