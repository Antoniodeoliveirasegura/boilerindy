import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import { PREVIEW_MESSAGE, PREVIEW_SIGN_UP_HREF, previewSignInHref } from '../lib/publicPreview'
import BrandMark from './BrandMark'
import Icon from './Icons'

// The signed-out visitor's bar on a preview route (issue #366), rendered by
// AppLayout in the navbar's place. It is the signed-out version of the app's
// top bar: the same .topbar band (paper with the 4px ink rule in light, ink in
// dark), the navbar's height (56 px on phones, 64 px from md) and the same
// spacer under it, so the page sits exactly where it does for a signed-in
// student and nothing moves when auth settles. It is a <header>, not a <nav>:
// signed out there is no app navigation, only a way home and the two account
// links, with "Create account" as the view's one amber button.
//
// The one-line pitch fits beside the links from `md` up. On a phone it moves
// to a fixed ink plate at the bottom, in the slot the signed-in bottom tab bar
// uses (SiteDisclaimer's mobile padding already clears it), because a fixed
// plate never shifts the page the way an in-flow banner would.
export default function PreviewBar() {
  const { pathname, search } = useLocation()
  const { dark, toggleTheme } = useTheme()

  return (
    <>
      <header data-testid="preview-bar" className="topbar fixed top-0 left-0 right-0 z-[1100] h-14 md:h-16">
        <div className="max-w-[1200px] mx-auto px-4 md:px-6 h-full flex items-center gap-2 md:gap-0">
          <Link to="/" className="topbar-brand shrink-0">
            <BrandMark size={32} />
            <span className="text-[17px] md:text-[18px] sr-only sm:not-sr-only">BoilerIndy</span>
          </Link>
          <span className="topbar-divider hidden md:block" aria-hidden="true" />
          <p className="hidden md:block flex-1 min-w-0 pl-3 pr-4 text-[13px] leading-snug text-[var(--color-txt-2)] line-clamp-2">
            {PREVIEW_MESSAGE}
          </p>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="icon-btn"
            >
              <Icon name={dark ? 'sun' : 'moon'} size={18} />
            </button>
            <Link to={previewSignInHref(pathname, search)} className="btn btn-ghost btn-sm whitespace-nowrap max-[380px]:px-2.5">
              Sign in
            </Link>
            <Link to={PREVIEW_SIGN_UP_HREF} className="btn btn-primary btn-sm whitespace-nowrap max-[380px]:px-2.5">
              Create account
            </Link>
          </div>
        </div>
      </header>
      <div className="h-14 md:h-16" aria-hidden="true" />
      <div
        data-testid="preview-note"
        className="md:hidden fixed left-0 right-0 bottom-0 z-40 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]"
      >
        <div
          role="status"
          aria-live="polite"
          className="ink-panel flex items-start gap-2.5 min-h-11 px-3.5 py-3 text-[13.5px] leading-snug text-[var(--color-ink-txt)] shadow-[var(--shadow-lg)]"
        >
          <Icon name="info" size={16} className="shrink-0 mt-0.5 text-[var(--color-ink-dim)]" />
          <span className="min-w-0">{PREVIEW_MESSAGE}</span>
        </div>
      </div>
    </>
  )
}
