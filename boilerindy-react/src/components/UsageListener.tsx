import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { configureAnalytics, track } from '../lib/usageStats'

// Bridges app state into the analytics client (issue #51): tracking is on only
// for signed-in users who have not opted out, and every route change records a
// page_view. Renders nothing.

export default function UsageListener() {
  const { user } = useAuth()
  const location = useLocation()

  const isTrackingEnabled = Boolean(user) && !user?.analyticsOptOut

  useEffect(() => {
    configureAnalytics({ enabled: isTrackingEnabled })
  }, [isTrackingEnabled])

  useEffect(() => {
    track('page_view', { path: location.pathname })
  }, [location.pathname])

  return null
}
