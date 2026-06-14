import { useCallback, useEffect, useMemo, useState } from 'react'
import { authRequest } from '../lib/authApi'
import {
  normalizeGrade,
  normalizeGrades,
  summarizeGrades,
  loadLocalGrades,
  saveLocalGrades,
} from '../lib/gradeTrackerStore'

/**
 * Owns the user's course list for the grade tracker (issue #10).
 *
 * Lifecycle mirrors useDashboardLayout: instant paint from the localStorage
 * cache, then GET /api/me/grades as the cross-device source of truth (falling
 * back to the cache, then an empty list). Mutations update local state + cache
 * immediately (optimistic) and sync to the server; a failed network call leaves
 * the optimistic copy in place so the UI stays responsive offline.
 *
 * @param {string | null | undefined} userId backend user id (from useAuth)
 */
export function useGradeTracker(userId) {
  const [grades, setGrades] = useState(() => loadLocalGrades(userId) || [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const data = await authRequest('/api/me/grades')
        if (cancelled) return
        // If the backend reports the store is unavailable (e.g. table not yet
        // migrated), don't trust its empty list — keep the local cache.
        if (data?.unavailable) {
          const cached = loadLocalGrades(userId)
          if (cached) setGrades(cached)
          return
        }
        const next = normalizeGrades(data?.grades)
        setGrades(next)
        saveLocalGrades(userId, next)
      } catch {
        if (cancelled) return
        const cached = loadLocalGrades(userId)
        if (cached) setGrades(cached)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  // Write helper: set state, mirror to cache.
  const persist = useCallback(
    (next) => {
      setGrades(next)
      saveLocalGrades(userId, next)
      return next
    },
    [userId],
  )

  const addGrade = useCallback(
    async (input) => {
      const normalized = normalizeGrade(input)
      if (!normalized) {
        setError('Enter a course name and pick a grade.')
        return false
      }
      setError('')
      // Optimistic insert with a temporary id; replaced by the server row on
      // success so a later refetch reconciles cleanly.
      const tempId = `temp-${userId}-${grades.length}-${normalized.courseName}`
      const optimistic = { ...normalized, id: tempId }
      const next = persist([...grades, optimistic])
      try {
        const data = await authRequest('/api/me/grades', {
          method: 'POST',
          body: JSON.stringify(normalized),
        })
        if (data?.grade) {
          persist(next.map((g) => (g.id === tempId ? data.grade : g)))
        }
        return true
      } catch (err) {
        setError(err.message || 'Could not save course (offline — kept locally).')
        return true // optimistic copy stays; cache keeps it
      }
    },
    [userId, grades, persist],
  )

  const updateGrade = useCallback(
    async (id, updates) => {
      const current = grades.find((g) => g.id === id)
      if (!current) return false
      const merged = normalizeGrade({ ...current, ...updates })
      if (!merged) {
        setError('Enter a course name and pick a grade.')
        return false
      }
      setError('')
      const next = persist(grades.map((g) => (g.id === id ? { ...merged, id } : g)))
      // Don't PATCH an unsynced optimistic row; the create call carries its data.
      if (String(id).startsWith('temp-')) return true
      try {
        await authRequest(`/api/me/grades/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(updates),
        })
      } catch (err) {
        setError(err.message || 'Could not update course (offline — kept locally).')
      }
      void next
      return true
    },
    [grades, persist],
  )

  const deleteGrade = useCallback(
    async (id) => {
      persist(grades.filter((g) => g.id !== id))
      if (String(id).startsWith('temp-')) return
      try {
        await authRequest(`/api/me/grades/${id}`, { method: 'DELETE' })
      } catch (err) {
        setError(err.message || 'Could not delete course (offline).')
      }
    },
    [grades, persist],
  )

  const summary = useMemo(() => summarizeGrades(grades), [grades])

  return { grades, summary, loading, error, addGrade, updateGrade, deleteGrade }
}
