import { Outlet } from 'react-router-dom'
import Navbar from './Navbar'
import CampusAssistant from './CampusAssistant'
import SessionExpiryWatcher from './SessionExpiryWatcher'
import SideSpotlightRail from './spotlight/SideSpotlightRail'

export default function AppLayout() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <SideSpotlightRail side="left" />
      <SideSpotlightRail side="right" />
      <Outlet />
      <CampusAssistant />
      <SessionExpiryWatcher />
    </div>
  )
}
