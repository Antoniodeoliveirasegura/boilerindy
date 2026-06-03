import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth, useSignOutAndRedirect } from '../context/AuthContext'
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

export default function Navbar() {
  const location = useLocation()
  const { user, getInitials, getDisplayName } = useAuth()
  const signOutAndRedirect = useSignOutAndRedirect()
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <>
      <nav
        className={`fixed top-0 left-0 right-0 z-[1100] transition-all duration-500 ease-out
          ${scrolled
            ? 'h-14 glass shadow-md border-b border-[var(--color-border)]'
            : 'h-16 bg-transparent'
          }`}
      >
        <div className="max-w-[1200px] mx-auto px-6 h-full flex items-center justify-between">
          <Link
            to="/dashboard"
            className="flex items-center gap-2.5 group"
          >
            <div className="relative">
              <span className="bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2.5 py-1 rounded-lg tracking-wider shadow-sm group-hover:shadow-md transition-shadow duration-300">
                IA
</span>
              <div className="absolute inset-0 bg-[var(--color-gold)] rounded-lg opacity-0 group-hover:opacity-20 blur-md transition-opacity duration-300" />
            </div>
            <span className="text-[15px] font-semibold text-[var(--color-txt-0)] tracking-tight hidden sm:block">
              IndyAssist
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-1 bg-[var(--color-bg-2)]/60 backdrop-blur-sm rounded-full p-1 border border-[var(--color-border)]">
            {navItems.map(({ path, label, icon }) => {
              const isActive = location.pathname === path
              return (
                <Link
                  key={path}
                  to={path}
                  onClick={() => setMenuOpen(false)}
                  className={`relative text-[13px] px-4 py-2 rounded-full flex items-center gap-2 transition-all duration-300
                    ${isActive
                      ? 'text-[var(--color-gold-dark)] font-medium'
                      : 'text-[var(--color-txt-1)] hover:text-[var(--color-txt-0)]'
                    }`}
                >
                  {isActive && (
                    <span
                      className="absolute inset-0 bg-gradient-to-r from-[var(--color-gold)] to-[var(--color-gold-light)] rounded-full animate-fade-in"
                      style={{ zIndex: -1 }}
                    />
                  )}
                  <Icon name={icon} size={15} strokeWidth={isActive ? 2.5 : 2} />
                  <span>{label}</span>
                </Link>
              )
            })}
          </div>

          <div className="flex items-center gap-3">
            <div className="relative hidden md:block">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className="w-10 h-10 rounded-xl bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center text-[12px] font-bold text-[var(--color-gold-dark)] shadow-sm hover:shadow-md transition-all duration-300 hover:scale-105"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                {user ? getInitials() : 'PI'}
              </button>
              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-[var(--color-success)] rounded-full border-2 border-[var(--color-bg-0)] pointer-events-none" />
              {menuOpen && (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-[1500] cursor-default"
                    aria-label="Close menu"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    role="menu"
                    className="absolute right-0 top-12 z-[1501] min-w-[220px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg py-1 text-left"
                  >
                    <div className="px-3 py-2 border-b border-[var(--color-border)]">
                      <div className="text-[13px] font-medium text-[var(--color-txt-0)] truncate">
                        {user ? getDisplayName() : 'Guest'}
                      </div>
                      {user?.email && (
                        <div className="text-[11px] text-[var(--color-txt-2)] truncate">{user.email}</div>
                      )}
                    </div>
                    <Link
                      to="/settings"
                      role="menuitem"
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] no-underline"
                      onClick={() => setMenuOpen(false)}
                    >
                      <Icon name="settings" size={14} />
                      Settings
                    </Link>
                    <Link
                      to="/setup"
                      role="menuitem"
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] no-underline"
                      onClick={() => setMenuOpen(false)}
                    >
                      <Icon name="calendar" size={14} />
                      Setup
                    </Link>
                    <Link
                      to="/"
                      role="menuitem"
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] no-underline"
                      onClick={() => setMenuOpen(false)}
                    >
                      <Icon name="home" size={14} />
                      Marketing site
                    </Link>
                    <button
                      type="button"
                      role="menuitem"
                      className="w-full text-left px-3 py-2 text-[13px] text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] border-0 bg-transparent cursor-pointer"
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
              className="md:hidden w-10 h-10 rounded-xl bg-[var(--color-bg-2)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-txt-1)] hover:text-[var(--color-txt-0)] transition-all duration-300"
              aria-label="Toggle menu"
            >
              <div className="relative w-5 h-5">
                <span className={`absolute left-0 block w-5 h-0.5 bg-current transition-all duration-300 ${mobileOpen ? 'top-2.5 rotate-45' : 'top-1'}`} />
                <span className={`absolute left-0 top-2.5 block w-5 h-0.5 bg-current transition-all duration-300 ${mobileOpen ? 'opacity-0 scale-0' : 'opacity-100'}`} />
                <span className={`absolute left-0 block w-5 h-0.5 bg-current transition-all duration-300 ${mobileOpen ? 'top-2.5 -rotate-45' : 'top-4'}`} />
              </div>
            </button>
          </div>
        </div>
      </nav>

      <div
        className={`fixed inset-0 bg-black/40 backdrop-blur-sm z-[2000] md:hidden transition-opacity duration-300 ${mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setMobileOpen(false)}
      />

      <div
        className={`fixed top-0 right-0 h-full w-72 bg-[var(--color-surface)] z-[2001] md:hidden transition-transform duration-500 ease-out shadow-xl ${mobileOpen ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="p-6 pt-20">
          <div className="space-y-2">
            {navItems.map(({ path, label, icon }, idx) => {
              const isActive = location.pathname === path
              return (
                <Link
                  key={path}
                  to={path}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300
                    ${isActive
                      ? 'bg-gradient-to-r from-[var(--color-gold)] to-[var(--color-gold-light)] text-[var(--color-gold-dark)] font-medium shadow-sm'
                      : 'text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)]'
                    }`}
                  style={{
                    animationDelay: `${idx * 0.05}s`,
                    opacity: mobileOpen ? 1 : 0,
                    transform: mobileOpen ? 'translateX(0)' : 'translateX(20px)',
                    transition: `all 0.3s ease ${idx * 0.05}s`
                  }}
                >
                  <Icon name={icon} size={20} />
                  <span className="text-[15px]">{label}</span>
                </Link>
              )
            })}
            <Link
              to="/settings"
              onClick={() => setMobileOpen(false)}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] transition-all duration-300"
            >
              <Icon name="settings" size={20} />
              <span className="text-[15px]">Settings</span>
            </Link>
          </div>

          <div className="mt-8 pt-6 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center text-[14px] font-bold text-[var(--color-gold-dark)]">
                {user ? getInitials() : 'PI'}
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-[var(--color-txt-0)] truncate">
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
              className="mx-4 mt-2 w-[calc(100%-2rem)] py-2.5 rounded-xl border border-[var(--color-border)] text-[13px] text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)]"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="h-16" />

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--color-surface)]/95 backdrop-blur-md border-t border-[var(--color-border)] safe-bottom">
        <div className="flex justify-around items-center h-16 px-2">
          {mobileNavItems.map(({ path, label, icon }) => {
            const isActive = location.pathname === path
            return (
              <Link
                key={path}
                to={path}
                className={`flex flex-col items-center justify-center gap-0.5 py-2 px-3 min-w-[64px] rounded-xl transition-all duration-200 ${
                  isActive
                    ? 'text-[var(--color-gold)]'
                    : 'text-[var(--color-txt-2)]'
                }`}
              >
                <div className={`p-1.5 rounded-lg transition-all duration-200 ${isActive ? 'bg-[var(--color-gold)]/15' : ''}`}>
                  <Icon name={icon} size={20} strokeWidth={isActive ? 2.5 : 2} />
                </div>
                <span className={`text-[10px] font-medium ${isActive ? 'text-[var(--color-gold)]' : ''}`}>{label}</span>
              </Link>
            )
          })}
        </div>
      </nav>
      
      {/* Bottom nav spacer for mobile */}
      <div className="md:hidden h-16" />
    </>
  )
}
