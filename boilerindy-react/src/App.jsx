import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { ThemeProvider } from './context/ThemeContext'
import { AuthProvider } from './context/AuthContext'
import AppLayout from './components/AppLayout'
import RequireAuth from './components/RequireAuth'
import RequireAdvertiser from './components/RequireAdvertiser'
import Landing from './pages/Landing'
import AdvertiserLogin from './pages/AdvertiserLogin'
import AdvertiserDashboard from './pages/advertiser/Dashboard'
import Login from './pages/Login'
import ResetPassword from './pages/ResetPassword'
import Privacy from './pages/Privacy'
import AuthCallback from './pages/AuthCallback'
import AnalyticsListener from './components/AnalyticsListener'
import Home from './pages/Home'
import Map from './pages/Map'
import Schedule from './pages/Schedule'
import Assignments from './pages/Assignments'
import Events from './pages/Events'
import FreeFood from './pages/FreeFood'
import LostFound from './pages/LostFound'
import Dining from './pages/Dining'
import Transit from './pages/Transit'
import Services from './pages/Services'
import Board from './pages/Board'
import ConnectSchedule from './pages/ConnectSchedule'
import Settings from './pages/Settings'
import RequireAdmin from './components/RequireAdmin'
import AdminLayout from './pages/admin/AdminLayout'
import AdminOverview from './pages/admin/AdminOverview'
import AdminLeads from './pages/admin/AdminLeads'
import AdminCampaigns from './pages/admin/AdminCampaigns'
import AdminAdvertisers from './pages/admin/AdminAdvertisers'

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <AnalyticsListener />
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/advertise" element={<AdvertiserLogin />} />
            <Route
              path="/advertise/dashboard"
              element={
                <RequireAdvertiser>
                  <AdvertiserDashboard />
                </RequireAdvertiser>
              }
            />
            {/* /demo was the old marketing preview; advertisers land on the portal now. */}
            <Route path="/demo" element={<Navigate to="/advertise" replace />} />
            <Route path="/login" element={<Login />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route element={<AppLayout />}>
              <Route
                path="/setup"
                element={
                  <RequireAuth>
                    <ConnectSchedule />
                  </RequireAuth>
                }
              />
              <Route
                path="/settings"
                element={
                  <RequireAuth>
                    <Settings />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <RequireAuth>
                    <Home />
                  </RequireAuth>
                }
              />
              <Route
                path="/map"
                element={
                  <RequireAuth>
                    <Map />
                  </RequireAuth>
                }
              />
              <Route
                path="/schedule"
                element={
                  <RequireAuth>
                    <Schedule />
                  </RequireAuth>
                }
              />
              <Route
                path="/assignments"
                element={
                  <RequireAuth>
                    <Assignments />
                  </RequireAuth>
                }
              />
              <Route
                path="/events"
                element={
                  <RequireAuth>
                    <Events />
                  </RequireAuth>
                }
              />
              <Route
                path="/free-food"
                element={
                  <RequireAuth>
                    <FreeFood />
                  </RequireAuth>
                }
              />
              <Route
                path="/lost-found"
                element={
                  <RequireAuth>
                    <LostFound />
                  </RequireAuth>
                }
              />
              <Route
                path="/dining"
                element={
                  <RequireAuth>
                    <Dining />
                  </RequireAuth>
                }
              />
              <Route
                path="/transit"
                element={
                  <RequireAuth>
                    <Transit />
                  </RequireAuth>
                }
              />
              <Route
                path="/services"
                element={
                  <RequireAuth>
                    <Services />
                  </RequireAuth>
                }
              />
              <Route
                path="/board"
                element={
                  <RequireAuth>
                    <Board />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin"
                element={
                  <RequireAuth>
                    <RequireAdmin>
                      <AdminLayout />
                    </RequireAdmin>
                  </RequireAuth>
                }
              >
                <Route index element={<AdminOverview />} />
                <Route path="leads" element={<AdminLeads />} />
                <Route path="campaigns" element={<AdminCampaigns />} />
                <Route path="advertisers" element={<AdminAdvertisers />} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
      <SpeedInsights />
    </ThemeProvider>
  )
}
