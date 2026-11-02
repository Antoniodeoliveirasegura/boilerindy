import { useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { saveCalendarRemindersOff, skipSetupToCarryOver } from '../lib/authApi'

// Before the account kept the calendar reminders choice
// (Antoniodeoliveirasegura/boilerindy-app#150), "Don't ask again" on Setup was
// saved only in the browser (pih-skip-setup). Once a signed-in session says
// the account has reminders on, that earlier choice is sent to the account, so
// the app and other browsers stop asking too. One try per page load; after a
// failure (a 503 before db/supabase-calendar-reminders.sql runs) the browser's
// flag keeps standing in and the next visit tries again. Renders nothing.

export default function SkipSetupCarryOver() {
  const { user, refreshSession } = useAuth()
  const sent = useRef(false)

  useEffect(() => {
    if (!user || !skipSetupToCarryOver(user) || sent.current) return
    sent.current = true
    saveCalendarRemindersOff(true).then(
      () => refreshSession(),
      () => {},
    )
  }, [user, refreshSession])

  return null
}
