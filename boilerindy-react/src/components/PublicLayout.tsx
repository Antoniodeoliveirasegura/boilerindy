import { Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import SiteDisclaimer from './SiteDisclaimer'
import PageLoader from './PageLoader'
import SkipLink from './SkipLink'

// Layout for the public and auth-flow routes that have no footer of their own
// (issue #112): the disclaimer has to reach every route, and reset-password,
// the OAuth callback and the advertiser dashboard used to render without it.
// Pages that carry a page-specific note (Landing, Login, AdvertiserLogin) or
// sit inside a document column (Privacy, Terms, Install) still place
// SiteDisclaimer themselves; the wording lives in that one component either way.
//
// The routed page is a `flex-1` child so it fills the viewport above the
// disclaimer instead of pushing it below the fold with its own `min-h-screen`.
export default function PublicLayout() {
  return (
    <div className="min-h-screen flex flex-col">
      <SkipLink />
      <main id="main" tabIndex={-1} className="flex-1 flex flex-col focus:outline-none">
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>
      <SiteDisclaimer />
    </div>
  )
}
