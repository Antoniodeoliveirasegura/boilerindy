/**
 * Frontend persistence + helpers for the grade tracker (issue #10).
 *
 * The validation/GPA rules live in the backend `src/gradeTracker.mjs`, shared
 * verbatim by the server (/api/me/grades) and the frontend. This module only
 * adds the browser-side localStorage cache keyed by backend user id (mirrors
 * dashboardLayoutStore), used as an offline/optimistic fallback when the API is
 * unreachable. Migrated to TypeScript (issue #20).
 */
import {
  GRADE_POINTS,
  NON_GPA_GRADES,
  LETTER_GRADES,
  DEFAULT_CREDIT_HOURS,
  DEFAULT_TERM,
  isGpaLetter,
  gradePoints,
  normalizeGrade,
  normalizeGrades,
  computeGpa,
  summarizeGrades,
} from '../../../src/gradeTracker.mjs'

export {
  GRADE_POINTS,
  NON_GPA_GRADES,
  LETTER_GRADES,
  DEFAULT_CREDIT_HOURS,
  DEFAULT_TERM,
  isGpaLetter,
  gradePoints,
  normalizeGrade,
  normalizeGrades,
  computeGpa,
  summarizeGrades,
}

function storageKey(userId: string): string {
  return `boilerindy-grades-v1-${userId}`
}

/** Read the cached grade list for a user, or null when nothing is cached. */
export function loadLocalGrades(userId: string | null | undefined) {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return null
    return normalizeGrades(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Persist a grade list to localStorage for a user. No-ops without a user id. */
export function saveLocalGrades(userId: string | null | undefined, grades: unknown): void {
  if (!userId) return
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(grades))
  } catch {
    /* storage unavailable / quota - DB copy remains the source of truth */
  }
}
