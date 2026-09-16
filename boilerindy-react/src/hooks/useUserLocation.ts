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
//
// What is stored is deliberately less than what is used (issue #294): the cache
// keeps coordinates rounded to 3 decimals (roughly 110 m) with a write time and
// is ignored after 12 hours, while React state keeps the full-precision fix for
// the live session. Sign-out removes every key below (see clearAiCaches), so the
// next student on a shared computer never inherits this one's position.

export type UserLocation = { lat: number; lon: number }

const CACHE_KEY = 'boilerindy-user-location-v2'
// Full-precision, untimestamped entries written by builds before issue #294.
const LEGACY_CACHE_KEY = 'boilerindy-user-location-v1'
const ASKED_KEY = 'boilerindy-geo-asked-v1'
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Every key this hook reads or writes, for sign-out to clear (issue #294).
 * ASKED_KEY is included on purpose: the next student on a shared machine should
 * get their own one-time permission prompt rather than silently running with no
 * location. The cost is one extra prompt for a student whose token was revoked
 * or expired and who signs back in on their own laptop; do not "fix" that by
 * keeping the key.
 */
export const LOCATION_STORAGE_KEYS: readonly string[] = [CACHE_KEY, LEGACY_CACHE_KEY, ASKED_KEY]

const GEO_OPTS: PositionOptions = { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }

function coarse(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** The cached position, or null when there is none, it is unreadable, or it is older than 12 hours. */
export function readCache(now: number = Date.now()): UserLocation | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (raw && typeof raw.lat === 'number' && typeof raw.lon === 'number' && typeof raw.ts === 'number') {
      const age = now - raw.ts
      if (age >= 0 && age <= CACHE_TTL_MS) return { lat: raw.lat, lon: raw.lon }
    }
  } catch {
    /* ignore unparseable / unavailable storage */
  }
  return null
}

/** Cache a coarse copy of the position with its write time. */
export function writeCache(loc: UserLocation, now: number = Date.now()): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ lat: coarse(loc.lat), lon: coarse(loc.lon), ts: now }))
  } catch {
    /* storage unavailable / quota - cache is best-effort */
  }
}

function removeLegacyCache(): void {
  try {
    localStorage.removeItem(LEGACY_CACHE_KEY)
  } catch {
    /* storage unavailable */
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
  const [location, setLocation] = useState<UserLocation | null>(() => readCache())

  useEffect(() => {
    // Drain the old full-precision key even on a machine where nobody ever
    // signs out, and even where geolocation is unavailable.
    removeLegacyCache()

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
