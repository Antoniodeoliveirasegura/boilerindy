import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth, useSignOutAndRedirect } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import BrandMark from './BrandMark'
import Icon from './Icons'

const navItems = [
  { path: '/dashboard', label: 'Home', icon: 'home' },
  { path: '/map', label: 'Map', icon: 'mapPin' },
  { path: '/schedule', label: 'Schedule', icon: 'schedule' },
  { path: '/assignments', label: 'Tasks', icon: 'document' },
  { path: '/events', label: 'Events', icon: 'users' },
  { path: '/services', label: 'More', icon: 'grid' },
]

const mobileNavItems = [
  { path: '/dashboard', label: 'Home', icon: 'home' },
  { path: '/schedule', label: 'Schedule', icon: 'schedule' },
  { path: '/map', label: 'Map', icon: 'mapPin' },
  { path: '/services', label: 'More', icon: 'grid' },
]

// The app shell's signage (transit wayfinding). Light theme: a paper band with
// a 4px ink rule under it. Dark theme: the ink band. The active stop carries a
// 4px amber bar. Below md the band shrinks to a 56px header with the menu
// button, and a fixed tab bar takes the four main stops. The look lives in
// index.css (.topbar, .topnav-link, .tabbar, .drawer-link, .menu-panel).
export default function Navbar() {
  const location = useLocation()
  const { user, getInitials, getDisplayName } = useAuth()
  const { dark, toggleTheme } = useTheme()
  const signOutAndRedirect = useSignOutAndRedirect()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <>
      <nav className="topbar fixed top-0 left-0 right-0 z-[1100] h-14 md:h-16">
        <div className="max-w-[1200px] mx-auto px-4 md:px-6 h-full flex items-stretch justify-between">
          <div className="flex items-stretch min-w-0">
            <Link to="/dashboard" className="topbar-brand self-center">
              <BrandMark size={32} />
              <span className="text-[17px] md:text-[18px]">BoilerIndy</span>
            </Link>

            <span className="topbar-divider hidden md:block" aria-hidden="true" />

            <div className="hidden md:flex items-stretch">
              {navItems.map(({ path, label, icon }) => {
                const isActive = location.pathname === path
                return (
                  <Link
                    key={path}
                    to={path}
                    onClick={() => setMenuOpen(false)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`topnav-link max-lg:px-3 ${isActive ? 'is-active' : ''}`}
                  >
                    <Icon name={icon} size={18} strokeWidth={isActive ? 2.25 : 2} className="max-lg:hidden" />
                    <span>{label}</span>
                  </Link>
                )
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative hidden md:block">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className="avatar"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                {user ? getInitials() : 'PI'}
              </button>
              <span className="avatar-online" />
              {menuOpen && (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-[1500] cursor-default"
                    aria-label="Close menu"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div role="menu" className="menu-panel absolute right-0 top-[56px] z-[1501] min-w-[240px]">
                    <div className="px-3.5 pt-2 pb-2.5 mb-1 border-b border-[var(--color-border)]">
                      <div className="font-display text-[14px] font-extrabold text-[var(--color-txt-0)] truncate">
                        {user ? getDisplayName() : 'Guest'}
                      </div>
                      {user?.email && (
                        <div className="text-[12px] text-[var(--color-txt-2)] truncate">{user.email}</div>
                      )}
                    </div>
                    <button type="button" role="menuitem" className="menu-item" onClick={toggleTheme}>
                      <Icon name={dark ? 'sun' : 'moon'} size={16} />
                      {dark ? 'Light mode' : 'Dark mode'}
                    </button>
                    <Link to="/settings" role="menuitem" className="menu-item" onClick={() => setMenuOpen(false)}>
                      <Icon name="settings" size={16} />
                      Settings
                    </Link>
                    {Boolean(user?.isAdmin) && (
                      <Link to="/admin" role="menuitem" className="menu-item" onClick={() => setMenuOpen(false)}>
                        <Icon name="shield" size={16} />
                        Admin console
                      </Link>
                    )}
                    <Link to="/setup" role="menuitem" className="menu-item" onClick={() => setMenuOpen(false)}>
                      <Icon name="calendar" size={16} />
                      Setup
                    </Link>
                    <Link to="/advertise" role="menuitem" className="menu-item" onClick={() => setMenuOpen(false)}>
                      <Icon name="briefcase" size={16} />
                      Advertiser portal
                    </Link>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item mt-1 border-t border-[var(--color-border)]"
                      onClick={() => {
                        setMenuOpen(false)
                        signOutAndRedirect()
                      }}
                    >
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>

            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="icon-btn md:hidden -mr-2"
              aria-label="Toggle menu"
            >
              <div className="relative w-5 h-5">
                <span className={`absolute left-0 block w-5 h-0.5 rounded-[1px] bg-current transition-transform duration-150 ${mobileOpen ? 'top-2.5 rotate-45' : 'top-1'}`} />
                <span className={`absolute left-0 top-2.5 block w-5 h-0.5 rounded-[1px] bg-current transition-opacity duration-150 ${mobileOpen ? 'opacity-0' : 'opacity-100'}`} />
                <span className={`absolute left-0 block w-5 h-0.5 rounded-[1px] bg-current transition-transform duration-150 ${mobileOpen ? 'top-2.5 -rotate-45' : 'top-4'}`} />
              </div>
            </button>
          </div>
        </div>
      </nav>

      <div
        className={`fixed inset-0 bg-black/50 z-[2000] md:hidden transition-opacity duration-200 ${mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setMobileOpen(false)}
      />

      <div
        className={`fixed top-0 right-0 h-full w-72 max-w-[85vw] overflow-y-auto bg-[var(--color-surface)] border-l border-[var(--color-border-2)] z-[2001] md:hidden transition-transform duration-200 ease-[var(--ease-snap)] ${mobileOpen ? 'translate-x-0 shadow-[var(--shadow-xl)]' : 'translate-x-full'}`}
      >
        <div className="px-4 pt-[calc(24px+env(safe-area-inset-top))] pb-6">
          <div className="space-y-1">
            {navItems.map(({ path, label, icon }) => {
              const isActive = location.pathname === path
              return (
                <Link
                  key={path}
                  to={path}
                  onClick={() => setMobileOpen(false)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`drawer-link ${isActive ? 'is-active' : ''}`}
                >
                  <Icon name={icon} size={20} />
                  <span>{label}</span>
                </Link>
              )
            })}
            <Link to="/settings" onClick={() => setMobileOpen(false)} className="drawer-link">
              <Icon name="settings" size={20} />
              <span>Settings</span>
            </Link>
            <button type="button" onClick={toggleTheme} className="drawer-link">
              <Icon name={dark ? 'sun' : 'moon'} size={20} />
              <span>{dark ? 'Light mode' : 'Dark mode'}</span>
            </button>
          </div>

          <div className="mt-6 pt-5 border-t border-[var(--color-border-2)]">
            <div className="flex items-center gap-3 px-1 py-2">
              <div className="avatar w-11 h-11 text-[14px] shrink-0">
                {user ? getInitials() : 'PI'}
              </div>
              <div className="min-w-0">
                <div className="font-display text-[15px] font-extrabold text-[var(--color-txt-0)] truncate">
                  {user ? getDisplayName() : 'Student'}
                </div>
                {user?.email && (
                  <div className="text-[12px] text-[var(--color-txt-2)] truncate">{user.email}</div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setMobileOpen(false)
                signOutAndRedirect()
              }}
              className="btn btn-secondary w-full mt-3"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="h-14 md:h-16" />

      {/* Mobile Bottom Navigation */}
      <nav className="tabbar md:hidden fixed bottom-0 left-0 right-0 z-40 safe-bottom">
        <div className="grid grid-cols-4">
          {mobileNavItems.map(({ path, label, icon }) => {
            const isActive = location.pathname === path
            return (
              <Link
                key={path}
                to={path}
                aria-current={isActive ? 'page' : undefined}
                className={`tabbar-link ${isActive ? 'is-active' : ''}`}
              >
                <Icon name={icon} size={22} strokeWidth={isActive ? 2.25 : 2} />
                <span>{label}</span>
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}
