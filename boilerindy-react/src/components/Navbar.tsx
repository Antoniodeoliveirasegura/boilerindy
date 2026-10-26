import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth, useSignOutAndRedirect } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { usePresence } from '../hooks/usePresence'
import BrandMark from './BrandMark'
import Icon from './Icons'
import { normalizeRoutePath } from '../lib/routePath'

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
  // Compared the way the router matches, so /dashboard/ or /Schedule still
  // light up their nav item.
  const currentPath = normalizeRoutePath(location.pathname)
  const { user, getInitials, getDisplayName } = useAuth()
  const { dark, toggleTheme } = useTheme()
  const signOutAndRedirect = useSignOutAndRedirect()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Any navigation (a link, Back, Forward) closes both menus. They used to stay
  // open over the next page, the drawer hiding most of it on phones. Reset
  // during render when the history entry changes, so the next page never
  // paints with a menu open, and Forward onto the old entry does not reopen it.
  const [menusFor, setMenusFor] = useState(location.key)
  if (menusFor !== location.key) {
    setMenusFor(location.key)
    setMobileOpen(false)
    setMenuOpen(false)
  }
  const menuRef = useRef<HTMLDivElement>(null)
  const avatarRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const drawerToggleRef = useRef<HTMLButtonElement>(null)
  // The account menu plays its exit before it leaves the page (docs/motion.md).
  const { attach: attachAccountMenu, mounted: accountMenuMounted, motion: accountMenuMotion } = usePresence(menuOpen)
  const topnavRef = useRef<HTMLDivElement>(null)
  const topnavSliderRef = useRef<HTMLSpanElement>(null)
  const topnavPlaced = useRef(false)
  // The tab bar's amber bar stays on the last tab while a page that is not a
  // tab shows, so it slides from there when one is picked again.
  const tabIndex = mobileNavItems.findIndex((item) => item.path === currentPath)
  const [tabSpot, setTabSpot] = useState(Math.max(tabIndex, 0))
  if (tabIndex >= 0 && tabIndex !== tabSpot) setTabSpot(tabIndex)

  // The top bar's amber bar slides to the current stop. The links are as wide
  // as their labels, so the current one is measured. The first placement and a
  // resize (a font arriving, the bar appearing from md up) jump; a move to
  // another page slides (index.css .topnav-slider).
  useLayoutEffect(() => {
    const nav = topnavRef.current
    const slider = topnavSliderRef.current
    if (!nav || !slider) return undefined
    const place = (slide: boolean) => {
      const link = nav.querySelector<HTMLElement>('[aria-current="page"]')
      if (!link || link.offsetWidth === 0) {
        slider.setAttribute('data-hidden', '')
        return
      }
      if (!slide) slider.style.transition = 'none'
      slider.removeAttribute('data-hidden')
      slider.style.setProperty('--nav-x', `${link.offsetLeft}px`)
      slider.style.setProperty('--nav-scale', String(link.offsetWidth / 100))
      if (!slide) {
        void slider.offsetWidth
        slider.style.transition = ''
      }
    }
    place(topnavPlaced.current)
    topnavPlaced.current = true
    if (typeof ResizeObserver !== 'function') return undefined
    let width = nav.offsetWidth
    const observer = new ResizeObserver(() => {
      if (nav.offsetWidth === width) return
      width = nav.offsetWidth
      place(false)
    })
    observer.observe(nav)
    return () => observer.disconnect()
  }, [currentPath])

  // Closing the drawer by its button, the dimmed page or Escape hands focus
  // back to the menu button; inert would otherwise drop it on the page body.
  const closeDrawer = () => {
    setMobileOpen(false)
    drawerToggleRef.current?.focus()
  }

  // A press outside the account menu closes it without being swallowed, so a
  // click on a nav link or the page also does what it says (a full-screen
  // click-catcher used to eat that first click). Escape closes it and hands
  // focus back to the avatar. Escape is caught on the way down and stopped
  // there, so it closes only this menu and not the assistant panel under it.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setMenuOpen(false)
      avatarRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menuOpen])

  // The phone drawer behaves as a dialog while open, like ConfirmDialog:
  // focus moves into it, Tab stays inside, Escape closes it (and only it, as
  // with the account menu) and returns focus to the menu button, and the page
  // behind stops scrolling. Before, Escape did nothing, Tab walked out to
  // controls the drawer covered, and the page scrolled under it. Widening
  // past the phone layout (rotating, resizing) closes it, since the drawer is
  // hidden there and its scroll lock and Tab trap would strand the page.
  useEffect(() => {
    if (!mobileOpen) return
    const drawer = drawerRef.current
    const toggle = drawerToggleRef.current
    const focusables = () =>
      Array.from(drawer?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])
    focusables()[0]?.focus({ preventScroll: true })
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMobileOpen(false)
        toggle?.focus()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (!drawer?.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    const wide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 768px)') : null
    const onWiden = () => {
      if (wide?.matches) setMobileOpen(false)
    }
    wide?.addEventListener('change', onWiden)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      wide?.removeEventListener('change', onWiden)
      document.body.style.overflow = prevOverflow
    }
  }, [mobileOpen])

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

            <div ref={topnavRef} className="relative hidden md:flex items-stretch">
              {navItems.map(({ path, label, icon }) => {
                const isActive = currentPath === path
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
              {/* Placed and shown by the layout effect above, before paint. */}
              <span ref={topnavSliderRef} className="topnav-slider" aria-hidden="true" />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div ref={menuRef} className="relative hidden md:block">
              <button
                ref={avatarRef}
                type="button"
                onClick={() => setMenuOpen(!menuOpen)}
                className="avatar"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                {user ? getInitials() : 'PI'}
              </button>
              <span className="avatar-online" />
              {accountMenuMounted && (
                <div
                  ref={attachAccountMenu}
                  role="menu"
                  data-motion={accountMenuMotion}
                  inert={!menuOpen}
                  className="menu-panel motion-pop origin-top-right absolute right-0 top-[56px] z-[1501] min-w-[240px]"
                >
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
              )}
            </div>

            <button
              ref={drawerToggleRef}
              type="button"
              onClick={() => setMobileOpen(!mobileOpen)}
              className="icon-btn md:hidden -mr-2"
              aria-label="Toggle menu"
              aria-expanded={mobileOpen}
              aria-controls="app-drawer"
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

      {/* The drawer slides in on the sheet timing and leaves faster
          (docs/motion.md), with no overshoot past the screen's edge. */}
      <div
        className={`fixed inset-0 bg-black/50 z-[2000] md:hidden transition-opacity ${mobileOpen ? 'opacity-100 duration-[var(--motion-scrim)]' : 'opacity-0 pointer-events-none duration-[var(--motion-base)]'}`}
        onClick={closeDrawer}
      />

      {/* inert while closed: the off-canvas links used to stay in the tab
          order and the accessibility tree. */}
      <div
        ref={drawerRef}
        id="app-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        inert={!mobileOpen}
        className={`fixed top-0 right-0 h-full w-72 max-w-[85vw] overflow-y-auto overscroll-contain bg-[var(--color-surface)] border-l border-[var(--color-border-2)] z-[2001] md:hidden transition-transform ${mobileOpen ? 'translate-x-0 shadow-[var(--shadow-xl)] duration-[var(--motion-slow)] ease-[var(--ease-out-expo)]' : 'translate-x-full duration-[var(--motion-base)] ease-[var(--ease-exit)]'}`}
      >
        {/* The drawer covers the menu button, so it carries its own close
            button in the same spot. Without it the first link (Home) sat
            under the button, and a second tap to close followed it. */}
        <div className="flex h-14 items-center justify-end pr-2 mt-[env(safe-area-inset-top)]">
          <button type="button" onClick={closeDrawer} className="icon-btn" aria-label="Close menu">
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="px-4 pt-1 pb-6">
          <div className="space-y-1">
            {navItems.map(({ path, label, icon }) => {
              const isActive = currentPath === path
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
            <Link
              to="/settings"
              onClick={() => setMobileOpen(false)}
              aria-current={currentPath === '/settings' ? 'page' : undefined}
              className={`drawer-link ${currentPath === '/settings' ? 'is-active' : ''}`}
            >
              <Icon name="settings" size={20} />
              <span>Settings</span>
            </Link>
            {/* The account menu, where this link lives on larger screens, is
                hidden on phones, so admins had no way into the console. */}
            {Boolean(user?.isAdmin) && (
              <Link
                to="/admin"
                onClick={() => setMobileOpen(false)}
                aria-current={currentPath === '/admin' ? 'page' : undefined}
                className={`drawer-link ${currentPath === '/admin' ? 'is-active' : ''}`}
              >
                <Icon name="shield" size={20} />
                <span>Admin console</span>
              </Link>
            )}
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
        <div className="relative grid grid-cols-4">
          {mobileNavItems.map(({ path, label, icon }) => {
            const isActive = currentPath === path
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
          <span
            className="tabbar-slider"
            aria-hidden="true"
            data-hidden={tabIndex < 0 ? '' : undefined}
            style={{ '--tab-index': tabSpot, '--tab-count': mobileNavItems.length } as CSSProperties}
          />
        </div>
      </nav>
    </>
  )
}
