// gradeTracker.mjs
//
// Pure validation + GPA math for the grade tracker (issue #10). Kept I/O-free so
// the rules are unit-testable and shared verbatim by the server
// (/api/me/grades) and the frontend. Untrusted input (DB row, request body,
// localStorage) is always run through normalizeGrade before use.

// Purdue 4.0 scale. A+ caps at 4.0 (Purdue does not award above 4.0). Listed
// highest -> lowest so the UI select reads top to bottom.
export const GRADE_POINTS = {
  'A+': 4.0,
  A: 4.0,
  'A-': 3.7,
  'B+': 3.3,
  B: 3.0,
  'B-': 2.7,
  'C+': 2.3,
  C: 2.0,
  'C-': 1.7,
  'D+': 1.3,
  D: 1.0,
  'D-': 0.7,
  F: 0.0,
}

// Grades that are recorded but excluded from GPA math (Pass, Withdraw,
// Incomplete). Stored so a transcript stays complete; they never move the GPA.
export const NON_GPA_GRADES = ['P', 'W', 'I']

// Every selectable letter, ordered for the dropdown (GPA grades then the rest).
export const LETTER_GRADES = [...Object.keys(GRADE_POINTS), ...NON_GPA_GRADES]
const LETTER_SET = new Set(LETTER_GRADES)

// Field bounds — shared by the server validator and the DB CHECK constraints.
export const MAX_COURSE_NAME = 120
export const MAX_TERM_NAME = 60
export const MAX_CREDIT_HOURS = 30
export const DEFAULT_CREDIT_HOURS = 3
export const DEFAULT_TERM = 'Other'

/** True when a letter contributes grade points (i.e. is on the 4.0 scale). */
export function isGpaLetter(letter) {
  return Object.prototype.hasOwnProperty.call(GRADE_POINTS, letter)
}

/** Grade points for a letter, or null for non-GPA / unknown letters. */
export function gradePoints(letter) {
  return isGpaLetter(letter) ? GRADE_POINTS[letter] : null
}

// Clamp a credit-hours value into [0, MAX], rounding to 2 decimals; non-numbers
// fall back to the default (3).
function normalizeCredits(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CREDIT_HOURS
  return Math.min(MAX_CREDIT_HOURS, Math.round(n * 100) / 100)
}

/**
 * Sanitize an arbitrary value into a valid course entry, or null if it cannot
 * be salvaged (missing name, unknown letter). IDs are preserved when present so
 * server rows round-trip; the UI may pass entries without an id (new course).
 *
 * @param {unknown} entry
 * @returns {{id: string|null, courseName: string, term: string, creditHours: number, letterGrade: string} | null}
 */
export function normalizeGrade(entry) {
  if (!entry || typeof entry !== 'object') return null
  const courseName = String(entry.courseName ?? '').trim().slice(0, MAX_COURSE_NAME)
  if (!courseName) return null
  const letterGrade = String(entry.letterGrade ?? '').trim()
  if (!LETTER_SET.has(letterGrade)) return null
  const term = String(entry.term ?? '').trim().slice(0, MAX_TERM_NAME) || DEFAULT_TERM
  return {
    id: entry.id ?? null,
    courseName,
    term,
    creditHours: normalizeCredits(entry.creditHours),
    letterGrade,
  }
}

/** Map a list of arbitrary entries to valid course entries (dropping bad ones). */
export function normalizeGrades(input) {
  const source = Array.isArray(input) ? input : []
  const out = []
  for (const entry of source) {
    const normalized = normalizeGrade(entry)
    if (normalized) out.push(normalized)
  }
  return out
}

/**
 * Cumulative GPA over a list of courses. Only GPA-scale letters with positive
 * credit hours count. Returns { gpa: number|null, credits, points } — gpa is
 * null when nothing countable is present (so callers can show a placeholder
 * rather than a misleading 0.00).
 *
 * @param {{creditHours: number, letterGrade: string}[]} courses
 */
export function computeGpa(courses) {
  let credits = 0
  let points = 0
  for (const c of Array.isArray(courses) ? courses : []) {
    const gp = gradePoints(c?.letterGrade)
    const ch = normalizeCredits(c?.creditHours)
    if (gp === null || ch <= 0) continue
    credits += ch
    points += gp * ch
  }
  return {
    gpa: credits > 0 ? Math.round((points / credits) * 1000) / 1000 : null,
    credits,
    points,
  }
}

/**
 * Group courses by term and attach a per-term GPA, plus the cumulative figure.
 * Term order follows first appearance in the input (the UI controls ordering).
 *
 * @param {{creditHours: number, letterGrade: string, term: string}[]} courses
 */
export function summarizeGrades(courses) {
  const list = Array.isArray(courses) ? courses : []
  const byTerm = new Map()
  for (const c of list) {
    const term = c?.term || DEFAULT_TERM
    if (!byTerm.has(term)) byTerm.set(term, [])
    byTerm.get(term).push(c)
  }
  const terms = [...byTerm.entries()].map(([term, items]) => ({
    term,
    courses: items,
    ...computeGpa(items),
  }))
  return { ...computeGpa(list), terms }
}
