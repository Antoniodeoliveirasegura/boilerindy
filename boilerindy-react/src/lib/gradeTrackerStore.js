/**
 * Frontend persistence + helpers for the grade tracker (issue #10).
 *
 * The validation/GPA rules live in the repo-root `gradeTracker.mjs`, shared
 * verbatim by the server (/api/me/grades) and the frontend. This module only
 * adds the browser-side localStorage cache keyed by backend user id (mirrors
 * dashboardLayoutStore), used as an offline/optimistic fallback when the API is
 * unreachable.
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
} from '../../../gradeTracker.mjs'

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

function storageKey(userId) {
  return `boilerindy-grades-v1-${userId}`
}

/**
 * Read the cached grade list for a user. Returns a normalized array, or null
 * when nothing is cached / storage is unavailable.
 *
 * @param {string | null | undefined} userId
 */
export function loadLocalGrades(userId) {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return null
    return normalizeGrades(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Persist a grade list to localStorage for a user. Silently no-ops without a
 * user id or when storage throws (private mode / quota).
 *
 * @param {string | null | undefined} userId
 * @param {unknown} grades
 */
export function saveLocalGrades(userId, grades) {
  if (!userId) return
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(grades))
  } catch {
    /* storage unavailable / quota — DB copy remains the source of truth */
  }
}
