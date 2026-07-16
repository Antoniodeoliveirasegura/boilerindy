import { Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import Navbar from './Navbar'
import CampusAssistant from './CampusAssistant'
import SessionExpiryWatcher from './SessionExpiryWatcher'
import SideSpotlightRail from './spotlight/SideSpotlightRail'
import SiteDisclaimer from './SiteDisclaimer'
import PageLoader from './PageLoader'

export default function AppLayout() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <SideSpotlightRail side="left" />
      <SideSpotlightRail side="right" />
      {/* Inner boundary: navbar + rails stay mounted while a page chunk loads. */}
      <Suspense fallback={<PageLoader />}>
        <Outlet />
      </Suspense>
      {/* Extra bottom padding on mobile clears the fixed bottom nav (issue #112). */}
      <SiteDisclaimer className="pb-20 md:pb-6" />
      <CampusAssistant />
      <SessionExpiryWatcher />
    </div>
  )
}
