import { Outlet } from 'react-router-dom'
import Navbar from './Navbar'
import CampusAssistant from './CampusAssistant'

export default function AppLayout() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <Outlet />
      <CampusAssistant />
    </div>
  )
}
