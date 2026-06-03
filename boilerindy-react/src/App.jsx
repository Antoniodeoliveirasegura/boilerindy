import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { ThemeProvider } from './context/ThemeContext'
import { AuthProvider } from './context/AuthContext'
import AppLayout from './components/AppLayout'
import RequireAuth from './components/RequireAuth'
import Landing from './pages/Landing'
import Login from './pages/Login'
import AuthCallback from './pages/AuthCallback'
import Home from './pages/Home'
import Map from './pages/Map'
import Schedule from './pages/Schedule'
import Assignments from './pages/Assignments'
import Events from './pages/Events'
import Dining from './pages/Dining'
import Transit from './pages/Transit'
import Services from './pages/Services'
import Board from './pages/Board'
import ConnectSchedule from './pages/ConnectSchedule'
import Settings from './pages/Settings'

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
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
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
      <SpeedInsights />
    </ThemeProvider>
  )
}
