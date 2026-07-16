import { useEffect, useState } from 'react'

// Cached, prompt-frugal geolocation for the dashboard.
//
// The problem this solves: calling navigator.geolocation.getCurrentPosition on
// every mount re-shows the browser's "allow location?" prompt each login when
// the grant doesn't persist (one-time allow, private windows, cleared on close).
//
// Strategy:
// - Return the last known position instantly from localStorage ("saved to
//   memory") so the UI never waits and survives a non-persisting grant.
// - Use the Permissions API: if already granted, refresh silently (no prompt).
// - Only ever surface the prompt ONCE (tracked in localStorage), and only when
//   autoPrompt is set - so a returning user is never nagged again.

export type UserLocation = { lat: number; lon: number }

const CACHE_KEY = 'boilerindy-user-location-v1'
const ASKED_KEY = 'boilerindy-geo-asked-v1'

const GEO_OPTS: PositionOptions = { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }

function readCache(): UserLocation | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (raw && typeof raw.lat === 'number' && typeof raw.lon === 'number') {
      return { lat: raw.lat, lon: raw.lon }
    }
  } catch {
    /* ignore unparseable / unavailable storage */
  }
  return null
}

function writeCache(loc: UserLocation): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(loc))
  } catch {
    /* storage unavailable / quota - cache is best-effort */
  }
}

function hasAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === '1'
  } catch {
    return false
  }
}

function markAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, '1')
  } catch {
    /* ignore */
  }
}

/**
 * @param autoPrompt When true, the browser permission prompt may be shown - but
 *   at most once, ever (subsequent loads reuse the cached position instead of
 *   re-prompting). When false, location is only read if permission is already
 *   granted. Defaults to false.
 */
export function useUserLocation({ autoPrompt = false }: { autoPrompt?: boolean } = {}): UserLocation | null {
  const [location, setLocation] = useState<UserLocation | null>(readCache)

  useEffect(() => {
    if (!navigator.geolocation) return

    const fetchNow = () =>
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude }
          setLocation(loc)
          writeCache(loc)
        },
        () => {
          /* denied / unavailable - keep the cached value, if any */
        },
        GEO_OPTS,
      )

    // Prompt at most once, ever; only on an explicit autoPrompt request.
    const maybePromptOnce = () => {
      if (autoPrompt && !hasAsked()) {
        markAsked()
        fetchNow()
      }
    }

    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'geolocation' as PermissionName })
        .then((status) => {
          if (status.state === 'granted') {
            fetchNow() // already allowed → silent, no prompt
          } else if (status.state === 'prompt') {
            maybePromptOnce()
          }
          // 'denied' → do nothing; cached value (if any) stays
        })
        .catch(maybePromptOnce)
    } else {
      maybePromptOnce()
    }
  }, [autoPrompt])

  return location
}
