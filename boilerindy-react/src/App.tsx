import { Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { ThemeProvider } from './context/ThemeContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import AppLayout from './components/AppLayout'
import PublicLayout from './components/PublicLayout'
import RequireAuth from './components/RequireAuth'
import RequireAdmin from './components/RequireAdmin'
import UsageListener from './components/UsageListener'
import ServerWakeNotice from './components/ServerWakeNotice'
import UpdateToast from './components/UpdateToast'
import PageLoader from './components/PageLoader'
import ScrollToTop from './components/ScrollToTop'
import { lazyRoute } from './lib/lazyRoute'

// Entry points stay eagerly bundled so the first paint never waits on a chunk.
import Landing from './pages/Landing'
import Login from './pages/Login'

// Every other route is code-split and fetched on demand - Map (Leaflet), the
// admin/advertiser areas, and the feature pages no longer ship in the initial load.
const RequireAdvertiser = lazyRoute(() => import('./components/RequireAdvertiser'))
const AdvertiserLogin = lazyRoute(() => import('./pages/AdvertiserLogin'))
const AdvertiserResetPassword = lazyRoute(() => import('./pages/AdvertiserResetPassword'))
const AdvertiserDashboard = lazyRoute(() => import('./pages/advertiser/Dashboard'))
const ResetPassword = lazyRoute(() => import('./pages/ResetPassword'))
const Privacy = lazyRoute(() => import('./pages/Privacy'))
const Terms = lazyRoute(() => import('./pages/Terms'))
const DeleteAccount = lazyRoute(() => import('./pages/DeleteAccount'))
const Support = lazyRoute(() => import('./pages/Support'))
const Install = lazyRoute(() => import('./pages/Install'))
const AuthCallback = lazyRoute(() => import('./pages/AuthCallback'))
const NotFound = lazyRoute(() => import('./pages/NotFound'))
const Home = lazyRoute(() => import('./pages/Home'))
const Map = lazyRoute(() => import('./pages/Map'))
const Schedule = lazyRoute(() => import('./pages/Schedule'))
const Assignments = lazyRoute(() => import('./pages/Assignments'))
const GradeTracker = lazyRoute(() => import('./pages/GradeTracker'))
const Events = lazyRoute(() => import('./pages/Events'))
const FreeFood = lazyRoute(() => import('./pages/FreeFood'))
const LostFound = lazyRoute(() => import('./pages/LostFound'))
const Guide = lazyRoute(() => import('./pages/Guide'))
const StudyGroups = lazyRoute(() => import('./pages/StudyGroups'))
const Perks = lazyRoute(() => import('./pages/Perks'))
const Marketplace = lazyRoute(() => import('./pages/Marketplace'))
const Friends = lazyRoute(() => import('./pages/Friends'))
const Dining = lazyRoute(() => import('./pages/Dining'))
const Transit = lazyRoute(() => import('./pages/Transit'))
const Parking = lazyRoute(() => import('./pages/Parking'))
const Clubs = lazyRoute(() => import('./pages/Clubs'))
const Services = lazyRoute(() => import('./pages/Services'))
const Board = lazyRoute(() => import('./pages/Board'))
const ConnectSchedule = lazyRoute(() => import('./pages/ConnectSchedule'))
const Settings = lazyRoute(() => import('./pages/Settings'))
const AdminLayout = lazyRoute(() => import('./pages/admin/AdminLayout'))
const AdminOverview = lazyRoute(() => import('./pages/admin/AdminOverview'))
const AdminLeads = lazyRoute(() => import('./pages/admin/AdminLeads'))
const AdminCampaigns = lazyRoute(() => import('./pages/admin/AdminCampaigns'))
const AdminAdvertisers = lazyRoute(() => import('./pages/admin/AdminAdvertisers'))
const AdminDeleted = lazyRoute(() => import('./pages/admin/AdminDeleted'))
const AdminReports = lazyRoute(() => import('./pages/admin/AdminReports'))

// The student pages, fetched in idle time once someone is signed in, so the
// first visit to each renders at once. With router transitions off (below), a
// page still downloading shows the loader, and React keeps it up for at least
// 300 ms, which every first visit paid even when the chunk was cached.
// Skipped when the device asks to save data.
const STUDENT_PAGES = [
  Home, Map, Schedule, Assignments, GradeTracker, Events, FreeFood, LostFound, Guide, StudyGroups, Perks,
  Marketplace, Friends, Dining, Transit, Parking, Clubs, Services, Board, ConnectSchedule, Settings,
]

function PreloadStudentPages() {
  const { user } = useAuth()
  const signedIn = Boolean(user)
  useEffect(() => {
    if (!signedIn) return
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return
    const run = () => STUDENT_PAGES.forEach((page) => page.preload())
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(run, { timeout: 5000 })
      return () => window.cancelIdleCallback(id)
    }
    const timer = setTimeout(run, 2000)
    return () => clearTimeout(timer)
  }, [signedIn])
  return null
}

export default function App() {
  return (
    <ThemeProvider>
      {/* No transitions: React Router 7 otherwise applies every location change
          as a low-priority transition, so a session update rendered first
          against the old URL. That raced sign-in (back to /dashboard instead of
          ?next) and sign-out (to /login instead of the landing page), and it
          kept the old page and tab title on screen with no loader while a new
          page's chunk downloaded. Nothing here relies on transitions. */}
      <BrowserRouter useTransitions={false}>
        <ScrollToTop />
        <AuthProvider>
          <UsageListener />
          <PreloadStudentPages />
          <ServerWakeNotice />
          <UpdateToast />
          <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/advertise" element={<AdvertiserLogin />} />
            {/* /demo was the old marketing preview; advertisers land on the portal now. */}
            <Route path="/demo" element={<Navigate to="/advertise" replace />} />
            <Route path="/login" element={<Login />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/delete-account" element={<DeleteAccount />} />
            <Route path="/support" element={<Support />} />
            <Route path="/install" element={<Install />} />
            {/* Routes with no footer of their own get the disclaimer from PublicLayout (issue #112). */}
            <Route element={<PublicLayout />}>
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/advertise/reset-password" element={<AdvertiserResetPassword />} />
              <Route
                path="/advertise/dashboard"
                element={
                  <RequireAdvertiser>
                    {/* advertiser is injected by RequireAdvertiser via cloneElement; passed
                        here only to satisfy the prop type while Dashboard's typed version
                        (optional advertiser) lands in its own PR. */}
                    <AdvertiserDashboard advertiser={undefined} />
                  </RequireAdvertiser>
                }
              />
              {/* Catch-all for unknown URLs (issues #245, #222). A splat ranks below every
                  static path, so it only answers what no other route matches. */}
              <Route path="*" element={<NotFound />} />
            </Route>
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
                path="/lost-found"
                element={
                  <RequireAuth>
                    <LostFound />
                  </RequireAuth>
                }
              />
              <Route
                path="/guide"
                element={
                  <RequireAuth>
                    <Guide />
                  </RequireAuth>
                }
              />
              <Route
                path="/study-groups"
                element={
                  <RequireAuth>
                    <StudyGroups />
                  </RequireAuth>
                }
              />
              <Route
                path="/perks"
                element={
                  <RequireAuth>
                    <Perks />
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
                path="/friends"
                element={
                  <RequireAuth>
                    <Friends />
                  </RequireAuth>
                }
              />
              {/* The public preview (issue #366): signed-out visitors may open these
                  four, which read only public data, and get AppLayout's preview bar.
                  The list lives in lib/publicPreview.ts. */}
              <Route path="/dining" element={<Dining />} />
              <Route path="/transit" element={<Transit />} />
              <Route path="/map" element={<Map />} />
              <Route path="/free-food" element={<FreeFood />} />
              <Route
                path="/parking"
                element={
                  <RequireAuth>
                    <Parking />
                  </RequireAuth>
                }
              />
              <Route
                path="/clubs"
                element={
                  <RequireAuth>
                    <Clubs />
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
                <Route path="reports" element={<AdminReports />} />
                <Route path="deleted" element={<AdminDeleted />} />
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
