import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import { PREVIEW_MESSAGE, PREVIEW_SIGN_UP_HREF, previewSignInHref } from '../lib/publicPreview'
import BrandMark from './BrandMark'
import Icon from './Icons'
import StatusBanner from './StatusBanner'

// The signed-out visitor's bar on a preview route (issue #366), rendered by
// AppLayout in the navbar's place. It is the same height as the navbar and
// keeps the same 64 px spacer, so the page sits exactly where it does for a
// signed-in student and nothing moves when auth settles. It is a <header>, not
// a <nav>: signed out there is no app navigation, only a way home and the two
// account links.
//
// The one-line pitch fits beside the links from `md` up. On a phone it moves
// to a fixed card at the bottom, in the slot the signed-in bottom tab bar
// uses (SiteDisclaimer's mobile padding already clears it), because a fixed
// card never shifts the page the way an in-flow banner would.
export default function PreviewBar() {
  const { pathname, search } = useLocation()
  const { dark, toggleTheme } = useTheme()

  return (
    <>
      <header
        data-testid="preview-bar"
        className="fixed top-0 left-0 right-0 z-[1100] h-16 glass border-b border-[var(--color-border)]"
      >
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 h-full flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2.5 shrink-0 no-underline">
            <BrandMark className="rounded-[22%] shadow-sm" />
            <span className="text-[15px] font-semibold text-[var(--color-txt-0)] tracking-tight sr-only sm:not-sr-only">
              BoilerIndy
            </span>
          </Link>
          <p className="hidden md:block flex-1 min-w-0 text-[13px] leading-snug text-[var(--color-txt-1)] line-clamp-2">
            {PREVIEW_MESSAGE}
          </p>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] transition-colors"
            >
              <Icon name={dark ? 'sun' : 'moon'} size={16} />
            </button>
            <Link
              to={previewSignInHref(pathname, search)}
              className="text-[13px] text-[var(--color-txt-1)] px-2.5 sm:px-3.5 py-1.5 rounded-lg hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] no-underline whitespace-nowrap"
            >
              Sign in
            </Link>
            <Link
              to={PREVIEW_SIGN_UP_HREF}
              className="text-[13px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-3.5 sm:px-4 py-1.5 rounded-lg no-underline whitespace-nowrap hover:brightness-105"
            >
              Create account
            </Link>
          </div>
        </div>
      </header>
      <div className="h-16" aria-hidden="true" />
      <div
        data-testid="preview-note"
        className="md:hidden fixed left-0 right-0 bottom-0 z-40 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]"
      >
        <StatusBanner tone="info" className="shadow-[var(--shadow-xl)]">
          {PREVIEW_MESSAGE}
        </StatusBanner>
      </div>
    </>
  )
}
