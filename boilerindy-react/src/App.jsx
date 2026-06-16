import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { ThemeProvider } from './context/ThemeContext'
import { AuthProvider } from './context/AuthContext'
import AppLayout from './components/AppLayout'
import RequireAuth from './components/RequireAuth'
import RequireAdmin from './components/RequireAdmin'
import UsageListener from './components/UsageListener'
import PageLoader from './components/PageLoader'

// Entry points stay eagerly bundled so the first paint never waits on a chunk.
import Landing from './pages/Landing'
import Login from './pages/Login'

// Every other route is code-split and fetched on demand — Map (Leaflet), the
// admin/advertiser areas, and the feature pages no longer ship in the initial load.
const RequireAdvertiser = lazy(() => import('./components/RequireAdvertiser'))
const AdvertiserLogin = lazy(() => import('./pages/AdvertiserLogin'))
const AdvertiserResetPassword = lazy(() => import('./pages/AdvertiserResetPassword'))
const AdvertiserDashboard = lazy(() => import('./pages/advertiser/Dashboard'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const Privacy = lazy(() => import('./pages/Privacy'))
const AuthCallback = lazy(() => import('./pages/AuthCallback'))
const Home = lazy(() => import('./pages/Home'))
const Map = lazy(() => import('./pages/Map'))
const Schedule = lazy(() => import('./pages/Schedule'))
const Assignments = lazy(() => import('./pages/Assignments'))
const GradeTracker = lazy(() => import('./pages/GradeTracker'))
const Events = lazy(() => import('./pages/Events'))
const FreeFood = lazy(() => import('./pages/FreeFood'))
const LostFound = lazy(() => import('./pages/LostFound'))
const Marketplace = lazy(() => import('./pages/Marketplace'))
const Dining = lazy(() => import('./pages/Dining'))
const Transit = lazy(() => import('./pages/Transit'))
const Services = lazy(() => import('./pages/Services'))
const Board = lazy(() => import('./pages/Board'))
const ConnectSchedule = lazy(() => import('./pages/ConnectSchedule'))
const Settings = lazy(() => import('./pages/Settings'))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const AdminOverview = lazy(() => import('./pages/admin/AdminOverview'))
const AdminLeads = lazy(() => import('./pages/admin/AdminLeads'))
const AdminCampaigns = lazy(() => import('./pages/admin/AdminCampaigns'))
const AdminAdvertisers = lazy(() => import('./pages/admin/AdminAdvertisers'))

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <UsageListener />
          <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/advertise" element={<AdvertiserLogin />} />
            <Route path="/advertise/reset-password" element={<AdvertiserResetPassword />} />
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
                path="/grade-tracker"
                element={
                  <RequireAuth>
                    <GradeTracker />
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
                path="/marketplace"
                element={
                  <RequireAuth>
                    <Marketplace />
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
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
      <SpeedInsights />
    </ThemeProvider>
  )
}
