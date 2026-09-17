import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { authRequest } from '../lib/authApi'
import {
  normalizeGrade,
  normalizeGrades,
  summarizeGrades,
  loadLocalGrades,
  saveLocalGrades,
} from '../lib/gradeTrackerStore'
import { isServerRefusal, writeFailureMessage } from '../lib/writeFailure'

/**
 * Owns the user's course list for the grade tracker (issue #10).
 *
 * Lifecycle mirrors useDashboardLayout: instant paint from the localStorage
 * cache, then GET /api/me/grades as the cross-device source of truth (falling
 * back to the cache, then an empty list). Mutations update local state + cache
 * immediately (optimistic) and sync to the server; a failed network call (or a
 * 5xx) leaves the optimistic copy in place so the UI stays responsive offline.
 * A 4xx is the server refusing the change (the 500-course cap's 409, the
 * user-write limiter's 429, a validation error), so the change is undone and
 * the server's message shown instead: a kept copy would be a course the
 * account never gets, and with a temp id its later edits and deletes would
 * never reach the server either (issue #202). Writes can overlap (a burst of
 * clicks at the limit), so every change, including a refusal's undo, applies
 * to the latest list rather than a copy taken when the click happened.
 * Migrated to TypeScript (issue #20).
 */

// Matches the shape produced by normalizeGrade in src/gradeTracker.mjs.
export type Grade = {
  id: string | null
  courseName: string
  term: string
  creditHours: number
  letterGrade: string
}

// Fields a caller supplies when adding/editing a course (id is assigned by the
// store/server). letterGrade + courseName are required for a row to be valid.
export type GradeInput = {
  courseName: string
  letterGrade: string
  term?: string
  creditHours?: number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : ''
}

export function useGradeTracker(userId: string | null | undefined) {
  const [grades, setGrades] = useState<Grade[]>(() => loadLocalGrades(userId) || [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // The list as last set, read by the write helpers so a response that lands
  // after other changes updates what is on screen now (issue #202).
  const gradesRef = useRef(grades)
  // Makes each optimistic row's temp id unique, even for the same course
  // added twice before either request settles, or a temp row cached by an
  // earlier visit.
  const tempSeqRef = useRef(0)

  const show = useCallback((next: Grade[]) => {
    gradesRef.current = next
    setGrades(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const data = (await authRequest('/api/me/grades')) as {
          unavailable?: boolean
          grades?: unknown
        }
        if (cancelled) return
        // If the backend reports the store is unavailable (e.g. table not yet
        // migrated), don't trust its empty list - keep the local cache.
        if (data?.unavailable) {
          const cached = loadLocalGrades(userId)
          if (cached) show(cached)
          return
        }
        const next = normalizeGrades(data?.grades)
        show(next)
        saveLocalGrades(userId, next)
      } catch {
        if (cancelled) return
        const cached = loadLocalGrades(userId)
        if (cached) show(cached)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId, show])

  // Write helper: apply a change to the latest list, show it, mirror to cache.
  const persist = useCallback(
    (change: (current: Grade[]) => Grade[]) => {
      const next = change(gradesRef.current)
      show(next)
      saveLocalGrades(userId, next)
    },
    [userId, show],
  )

  const addGrade = useCallback(
    async (input: GradeInput): Promise<boolean> => {
      const normalized = normalizeGrade(input)
      if (!normalized) {
        setError('Enter a course name and pick a grade.')
        return false
      }
      setError('')
      // Optimistic insert with a temporary id; replaced by the server row on
      // success so a later refetch reconciles cleanly.
      tempSeqRef.current += 1
      const tempId = `temp-${userId}-${Date.now()}-${tempSeqRef.current}-${normalized.courseName}`
      persist((list) => [...list, { ...normalized, id: tempId }])
      try {
        const data = (await authRequest('/api/me/grades', {
          method: 'POST',
          body: JSON.stringify(normalized),
        })) as { grade?: Grade }
        if (data?.grade) {
          const saved = data.grade
          persist((list) => list.map((g) => (g.id === tempId ? saved : g)))
        }
        return true
      } catch (err) {
        if (isServerRefusal(err)) {
          // Drop the optimistic row and report failure so the form keeps what
          // was typed for another try.
          persist((list) => list.filter((g) => g.id !== tempId))
          setError(writeFailureMessage(err, 'Could not save course. Please try again.'))
          return false
        }
        setError(errorMessage(err) || 'Could not save course (offline - kept locally).')
        return true // optimistic copy stays; cache keeps it
      }
    },
    [userId, persist],
  )

  const updateGrade = useCallback(
    async (id: string, updates: Partial<GradeInput>): Promise<boolean> => {
      const current = gradesRef.current.find((g) => g.id === id)
      if (!current) return false
      const merged = normalizeGrade({ ...current, ...updates })
      if (!merged) {
        setError('Enter a course name and pick a grade.')
        return false
      }
      setError('')
      const edited = { ...merged, id }
      persist((list) => list.map((g) => (g.id === id ? edited : g)))
      // Don't PATCH an unsynced optimistic row; the create call carries its data.
      if (String(id).startsWith('temp-')) return true
      try {
        await authRequest(`/api/me/grades/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(updates),
        })
      } catch (err) {
        if (isServerRefusal(err)) {
          // Put the saved row back, unless a later edit has replaced this one;
          // false keeps the edit form open.
          persist((list) => list.map((g) => (g === edited ? current : g)))
          setError(writeFailureMessage(err, 'Could not update course. Please try again.'))
          return false
        }
        setError(errorMessage(err) || 'Could not update course (offline - kept locally).')
      }
      return true
    },
    [persist],
  )

  const deleteGrade = useCallback(
    async (id: string): Promise<void> => {
      setError('')
      const index = gradesRef.current.findIndex((g) => g.id === id)
      const removed = index >= 0 ? gradesRef.current[index] : null
      persist((list) => list.filter((g) => g.id !== id))
      if (String(id).startsWith('temp-')) return
      try {
        await authRequest(`/api/me/grades/${id}`, { method: 'DELETE' })
      } catch (err) {
        if (isServerRefusal(err)) {
          // The course is still on the account: put it back near where it was,
          // leaving every other change made since in place.
          if (removed) {
            persist((list) =>
              list.some((g) => g.id === id)
                ? list
                : [...list.slice(0, index), removed, ...list.slice(index)],
            )
          }
          setError(writeFailureMessage(err, 'Could not delete course. Please try again.'))
          return
        }
        setError(errorMessage(err) || 'Could not delete course (offline).')
      }
    },
    [persist],
  )

  const summary = useMemo(() => summarizeGrades(grades), [grades])

  return { grades, summary, loading, error, addGrade, updateGrade, deleteGrade }
}
