import { Suspense, useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { isPreviewPath } from '../lib/publicPreview'
import { syncScheduleOverridesFromServer } from '../lib/scheduleOverrideStore'
import Navbar from './Navbar'
import PreviewBar from './PreviewBar'
import CampusAssistant from './CampusAssistant'
import SessionExpiryWatcher from './SessionExpiryWatcher'
import SideSpotlightRail from './spotlight/SideSpotlightRail'
import SiteDisclaimer from './SiteDisclaimer'
import PageLoader from './PageLoader'
import SkipLink from './SkipLink'

export default function AppLayout() {
  const { user, loading } = useAuth()
  const { pathname } = useLocation()
  const userId = (user?.id as string | undefined) ?? null
  // The navbar, bottom tab bar, rails and assistant belong to the signed-in
  // app. Rendering them while auth loads flashed that app at signed-out
  // visitors before RequireAuth sent them to /login (issue #369). The outlet
  // still renders, so RequireAuth's "Loading…" shows. Routes stay guarded one
  // by one so the public preview (#366) can render here for signed-out visitors.
  const showChrome = !loading && Boolean(user)
  // On a preview route (lib/publicPreview.ts) the page renders before auth
  // settles, so the navbar's slot (56 px on phones, 64 px from md, the same
  // as the navbar's spacer) is held while it loads and then filled by the
  // navbar (signed in) or the preview bar (signed out), never shifting the
  // page. Every other route keeps no chrome at all signed out.
  const preview = isPreviewPath(pathname)
  const showPreviewBar = preview && !loading && !user
  const holdNavbarSlot = preview && loading

  // Reconcile this device's schedule edits with the server once the user is
  // known. Every page reads them from localStorage synchronously, so this only
  // has to land before the next render, not before the first one.
  useEffect(() => {
    if (!userId) return
    syncScheduleOverridesFromServer(userId)
  }, [userId])

  return (
    <div className="min-h-screen flex flex-col">
      <SkipLink />
      {holdNavbarSlot && <div className="h-14 md:h-16" aria-hidden="true" data-testid="navbar-slot" />}
      {showPreviewBar && <PreviewBar />}
      {showChrome && (
        <>
          <Navbar />
          <SideSpotlightRail side="left" />
          <SideSpotlightRail side="right" />
        </>
      )}
      {/* Block wrapper for the routed page (issue #162). Page roots are
          `max-w-* mx-auto`; as direct children of this flex column their auto
          margins switched off cross-axis stretch, so each page was sized
          shrink-to-fit and any strip wider than the viewport widened the whole
          page instead of scrolling inside its own container. As a block child
          the page fills the width again. `overflow-x-clip` (not hidden) is the
          safety net for stray horizontal overflow: clip does not create a
          scroll container, so `sticky` panels keep sticking to the viewport and
          the fixed navbar, bottom nav and assistant are unaffected. It is also
          the page's main landmark and the skip link's target (issue #221). */}
      <main id="main" tabIndex={-1} className="overflow-x-clip focus:outline-none">
        {/* Inner boundary: navbar + rails stay mounted while a page chunk loads. */}
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>
      {/* Extra bottom padding on mobile clears the fixed tab bar (62px) and the
          assistant button floating above it (issues #112, #249). From md the
          button sits 24px from the corner, 56px wide, so 96px side gutters
          keep the centred text clear of it at tablet widths, where the 880px
          column would otherwise run under the button; wider screens are
          already held by that column's max width. */}
      <SiteDisclaimer rule className="mt-auto pb-[calc(136px+env(safe-area-inset-bottom))] md:px-24 md:pb-8" />
      {showChrome && <CampusAssistant />}
      <SessionExpiryWatcher />
    </div>
  )
}
