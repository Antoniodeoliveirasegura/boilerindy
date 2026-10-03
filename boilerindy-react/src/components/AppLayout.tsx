import { Suspense, useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { syncScheduleOverridesFromServer } from '../lib/scheduleOverrideStore'
import Navbar from './Navbar'
import CampusAssistant from './CampusAssistant'
import SessionExpiryWatcher from './SessionExpiryWatcher'
import SideSpotlightRail from './spotlight/SideSpotlightRail'
import SiteDisclaimer from './SiteDisclaimer'
import PageLoader from './PageLoader'
import SkipLink from './SkipLink'

export default function AppLayout() {
  const { user, loading } = useAuth()
  const userId = (user?.id as string | undefined) ?? null
  // The navbar, bottom tab bar, rails and assistant belong to the signed-in
  // app. Rendering them while auth loads flashed that app at signed-out
  // visitors before RequireAuth sent them to /login (issue #369). The outlet
  // still renders, so RequireAuth's "Loading…" shows. Routes stay guarded one
  // by one so a public preview (#366) can render here for signed-out visitors.
  const showChrome = !loading && Boolean(user)

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
      {/* Extra bottom padding on mobile clears the fixed bottom nav (issue #112). */}
      <SiteDisclaimer className="mt-auto pb-20 md:pb-6" />
      {showChrome && <CampusAssistant />}
      <SessionExpiryWatcher />
    </div>
  )
}
