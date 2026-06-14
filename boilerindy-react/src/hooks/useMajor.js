import { useCallback, useEffect, useRef, useState } from 'react'
import { authRequest } from '../lib/authApi'

/**
 * Owns the user's selected major for the degree planner (issue #18).
 *
 * Instant paint from a localStorage cache, then GET /api/me/degree as the
 * cross-device source of truth. setMajor is optimistic: local + cache update
 * immediately, then PUT (fire-and-forget; the cache keeps the choice if the
 * network drops).
 *
 * @param {string | null | undefined} userId backend user id (from useAuth)
 */
function cacheKey(userId) {
  return `boilerindy-major-v1-${userId}`
}

function readCache(userId) {
  if (!userId) return null
  try {
    return localStorage.getItem(cacheKey(userId)) || null
  } catch {
    return null
  }
}

function writeCache(userId, major) {
  if (!userId) return
  try {
    if (major) localStorage.setItem(cacheKey(userId), major)
    else localStorage.removeItem(cacheKey(userId))
  } catch {
    /* storage unavailable */
  }
}

export function useMajor(userId) {
  const [major, setMajorState] = useState(() => readCache(userId))
  const [loading, setLoading] = useState(true)
  // Set once the user picks a major, so a slower initial GET can't clobber a
  // selection they made mid-load. Reset per userId.
  const userChosenRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    userChosenRef.current = false
    ;(async () => {
      setLoading(true)
      try {
        const data = await authRequest('/api/me/degree')
        if (cancelled || userChosenRef.current) return
        const next = data?.major ?? null
        setMajorState(next)
        writeCache(userId, next)
      } catch {
        if (!cancelled && !userChosenRef.current) setMajorState(readCache(userId))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  const setMajor = useCallback(
    (value) => {
      const next = value || null
      userChosenRef.current = true
      setMajorState(next)
      writeCache(userId, next)
      authRequest('/api/me/degree', {
        method: 'PUT',
        body: JSON.stringify({ major: next }),
      }).catch(() => {
        /* offline — cache holds the choice until the next successful PUT */
      })
    },
    [userId],
  )

  return { major, setMajor, loading }
}
