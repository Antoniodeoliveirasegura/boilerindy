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
 * cache, then GET /api/me/grades as the cross-device source of truth. When
 * that read fails (no response, a 5xx, or the server reporting the store
 * unavailable) the cache stays on screen and `loadFailed` is set, so the page
 * can say the list may be incomplete rather than show "No courses yet" to a
 * student whose courses are on the account (R12); `retryLoad` reads again.
 * Mutations update local state + cache immediately (optimistic) and sync to
 * the server. A write that fails is undone and reported, whatever the cause.
 * A 4xx is the server refusing the change (the 500-course cap's 409, the
 * user-write limiter's 429, a validation error), and its message is shown
 * (issue #202). With no response or a 5xx the server never stored the change
 * either: a copy kept only on this device was counted in the GPA and then
 * lost on the next visit, when the server's list replaced it (R8). Writes can
 * overlap (a burst of clicks at the limit), so every change, including an
 * undo, applies to the latest list rather than a copy taken when the click
 * happened. Migrated to TypeScript (issue #20).
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

// Changes made to a course while its create is still in flight. The POST has
// already left with the values from before them, so addGrade sends them to
// the saved row once it answers.
type PendingCreate = { updates: Partial<GradeInput>; deleted: boolean }

// What to tell the student about a failed write. A refusal carries the
// server's own message. Without a response, or on a 5xx, the error's own text
// is the browser's "Failed to fetch" or a server error, which says nothing
// useful, so the line says what to do instead (R8).
function failureMessage(err: unknown, action: string): string {
  return isServerRefusal(err)
    ? writeFailureMessage(err, `Could not ${action}. Please try again.`)
    : `Could not ${action}. Check your connection and try again.`
}

export function useGradeTracker(userId: string | null | undefined) {
  const [grades, setGrades] = useState<Grade[]>(() => loadLocalGrades(userId) || [])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [error, setError] = useState('')
  // The list as last set, read by the write helpers so a response that lands
  // after other changes updates what is on screen now (issue #202).
  const gradesRef = useRef(grades)
  // Makes each optimistic row's temp id unique, even for the same course
  // added twice before either request settles, or a temp row cached by an
  // earlier visit.
  const tempSeqRef = useRef(0)
  // Creates still waiting on the server, by temp id. An edit made meanwhile
  // was dropped when the create answered with the old values, and a delete
  // left the server's row to come back on the next visit (R10).
  const pendingCreatesRef = useRef(new Map<string, PendingCreate>())
  // The server id each answered create got, by temp id, for a caller still
  // holding the temp id, such as an edit form opened before the create answered.
  const savedIdsRef = useRef(new Map<string, string>())

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
          setLoadFailed(true)
          return
        }
        const next = normalizeGrades(data?.grades)
        show(next)
        saveLocalGrades(userId, next)
        setLoadFailed(false)
      } catch {
        if (cancelled) return
        const cached = loadLocalGrades(userId)
        if (cached) show(cached)
        setLoadFailed(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId, show, loadAttempt])

  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), [])

  // Write helper: apply a change to the latest list, show it, mirror to cache.
  const persist = useCallback(
    (change: (current: Grade[]) => Grade[]) => {
      const next = change(gradesRef.current)
      show(next)
      saveLocalGrades(userId, next)
    },
    [userId, show],
  )

  const updateGrade = useCallback(
    async (requestedId: string, updates: Partial<GradeInput>): Promise<boolean> => {
      const id = savedIdsRef.current.get(requestedId) ?? requestedId
      const current = gradesRef.current.find((g) => g.id === id)
      if (!current) {
        // The course was deleted after the edit began. Saying so beats a Save
        // that does nothing (R53).
        setError('This course was removed.')
        return false
      }
      const merged = normalizeGrade({ ...current, ...updates })
      if (!merged) {
        setError('Enter a course name and pick a grade.')
        return false
      }
      setError('')
      const edited = { ...merged, id }
      persist((list) => list.map((g) => (g.id === id ? edited : g)))
      const pending = pendingCreatesRef.current.get(id)
      if (pending) {
        Object.assign(pending.updates, updates)
        return true
      }
      // A temp row with no create in flight was cached by an earlier visit and
      // has no server row to patch.
      if (String(id).startsWith('temp-')) return true
      try {
        await authRequest(`/api/me/grades/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(updates),
        })
      } catch (err) {
        // Put the saved row back, unless a later edit has replaced this one;
        // false keeps the edit form open.
        persist((list) => list.map((g) => (g === edited ? current : g)))
        setError(failureMessage(err, 'update course'))
        return false
      }
      return true
    },
    [persist],
  )

  const deleteGrade = useCallback(
    async (requestedId: string): Promise<void> => {
      setError('')
      const id = savedIdsRef.current.get(requestedId) ?? requestedId
      const index = gradesRef.current.findIndex((g) => g.id === id)
      const removed = index >= 0 ? gradesRef.current[index] : null
      persist((list) => list.filter((g) => g.id !== id))
      const pending = pendingCreatesRef.current.get(id)
      if (pending) {
        pending.deleted = true
        return
      }
      if (String(id).startsWith('temp-')) return
      try {
        await authRequest(`/api/me/grades/${id}`, { method: 'DELETE' })
      } catch (err) {
        // The course is still on the account: put it back near where it was,
        // leaving every other change made since in place.
        if (removed) {
          persist((list) =>
            list.some((g) => g.id === id)
              ? list
              : [...list.slice(0, index), removed, ...list.slice(index)],
          )
        }
        setError(failureMessage(err, 'delete course'))
      }
    },
    [persist],
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
      const pending: PendingCreate = { updates: {}, deleted: false }
      pendingCreatesRef.current.set(tempId, pending)
      persist((list) => [...list, { ...normalized, id: tempId }])
      let data: { grade?: Grade } | undefined
      try {
        data = (await authRequest('/api/me/grades', {
          method: 'POST',
          body: JSON.stringify(normalized),
        })) as { grade?: Grade }
      } catch (err) {
        // Drop the optimistic row and report failure so the form keeps what
        // was typed for another try.
        persist((list) => list.filter((g) => g.id !== tempId))
        setError(failureMessage(err, 'save course'))
        return false
      } finally {
        pendingCreatesRef.current.delete(tempId)
      }
      const saved = data?.grade
      if (!saved) return true
      const savedId = saved.id
      if (savedId) savedIdsRef.current.set(tempId, savedId)
      if (pending.deleted) {
        if (savedId) await deleteGrade(savedId)
        return true
      }
      persist((list) => list.map((g) => (g.id === tempId ? saved : g)))
      // Checked because a reload that landed meanwhile replaces the list.
      const stillShown = gradesRef.current.some((g) => g.id === savedId)
      if (savedId && stillShown && Object.keys(pending.updates).length > 0) {
        await updateGrade(savedId, pending.updates)
      }
      return true
    },
    [userId, persist, updateGrade, deleteGrade],
  )

  const summary = useMemo(() => summarizeGrades(grades), [grades])

  return {
    grades,
    summary,
    loading,
    loadFailed,
    retryLoad,
    error,
    addGrade,
    updateGrade,
    deleteGrade,
  }
}
