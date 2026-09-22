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

export default function AppLayout() {
  const { user } = useAuth()
  const userId = (user?.id as string | undefined) ?? null

  // Reconcile this device's schedule edits with the server once the user is
  // known. Every page reads them from localStorage synchronously, so this only
  // has to land before the next render, not before the first one.
  useEffect(() => {
    if (!userId) return
    syncScheduleOverridesFromServer(userId)
  }, [userId])

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <SideSpotlightRail side="left" />
      <SideSpotlightRail side="right" />
      {/* Block wrapper for the routed page (issue #162). Page roots are
          `max-w-* mx-auto`; as direct children of this flex column their auto
          margins switched off cross-axis stretch, so each page was sized
          shrink-to-fit and any strip wider than the viewport widened the whole
          page instead of scrolling inside its own container. As a block child
          the page fills the width again. `overflow-x-clip` (not hidden) is the
          safety net for stray horizontal overflow: clip does not create a
          scroll container, so `sticky` panels keep sticking to the viewport and
          the fixed navbar, bottom nav and assistant are unaffected. */}
      <div className="overflow-x-clip">
        {/* Inner boundary: navbar + rails stay mounted while a page chunk loads. */}
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </div>
      {/* Extra bottom padding on mobile clears the fixed bottom nav (issue #112). */}
      <SiteDisclaimer className="mt-auto pb-20 md:pb-6" />
      <CampusAssistant />
      <SessionExpiryWatcher />
    </div>
  )
}
