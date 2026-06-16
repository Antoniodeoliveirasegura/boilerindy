import { useCallback, useEffect, useRef, useState } from 'react'
import { authRequest } from '../lib/authApi'

/**
 * Owns the user's selected major for the degree planner (issue #18).
 * Instant paint from a localStorage cache, then GET /api/me/degree as the
 * cross-device source of truth. setMajor is optimistic.
 * Migrated to TypeScript (issue #20).
 */
function cacheKey(userId: string): string {
  return `boilerindy-major-v1-${userId}`
}

function readCache(userId: string | null | undefined): string | null {
  if (!userId) return null
  try {
    return localStorage.getItem(cacheKey(userId)) || null
  } catch {
    return null
  }
}

function writeCache(userId: string | null | undefined, major: string | null): void {
  if (!userId) return
  try {
    if (major) localStorage.setItem(cacheKey(userId), major)
    else localStorage.removeItem(cacheKey(userId))
  } catch {
    /* storage unavailable */
  }
}

export function useMajor(userId: string | null | undefined) {
  const [major, setMajorState] = useState<string | null>(() => readCache(userId))
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
        const data = (await authRequest('/api/me/degree')) as { major?: string | null }
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
    (value: string | null | undefined) => {
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
