import { useCallback, useEffect, useRef, useState } from 'react'
import { authRequest } from '../lib/authApi'
import { createWholeValueSaves, writeFailureMessage, type RefusedSave } from '../lib/writeFailure'

/**
 * Owns the user's selected major for the degree planner (issue #18).
 * Instant paint from a localStorage cache, then GET /api/me/degree as the
 * cross-device source of truth. setMajor is optimistic: an offline or 5xx
 * failure keeps the choice in the cache, while a refused PUT (the user-write
 * limiter's 429) puts back the major the server last accepted and sets
 * `error`, since the next load would drop the choice anyway (issue #202).
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
  const [error, setError] = useState('')
  const [saves] = useState(() => createWholeValueSaves<string | null>(major))
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
        if (cancelled) return
        const next = data?.major ?? null
        // What the server has, even when a pick made mid-load wins on screen:
        // a refused save of that pick puts this back.
        saves.loaded(next)
        if (userChosenRef.current) return
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
  }, [userId, saves])

  const setMajor = useCallback(
    (value: string | null | undefined) => {
      const next = value || null
      userChosenRef.current = true
      setMajorState(next)
      writeCache(userId, next)
      setError('')
      const ticket = saves.start()
      const restore = (refused: RefusedSave<string | null> | null) => {
        if (!refused) return
        setMajorState(refused.restore)
        writeCache(userId, refused.restore)
        setError(writeFailureMessage(refused.error, 'Could not save your major. Please try again.'))
      }
      authRequest('/api/me/degree', {
        method: 'PUT',
        body: JSON.stringify({ major: next }),
      }).then(
        () => restore(saves.succeeded(ticket, next)),
        // offline - cache holds the choice until the next successful PUT
        (err: unknown) => restore(saves.failed(ticket, err)),
      )
    },
    [userId, saves],
  )

  return { major, setMajor, loading, error }
}
