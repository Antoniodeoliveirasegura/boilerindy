// Study Group Finder (issue #33). Pure helpers — course-code normalization and
// input validation — kept here so they are unit-testable without DB/HTTP, and
// so Friend Matching (#17) can reuse the same normalizer.

// Purdue course codes look like "CS 18000", "MA 16500", "ENGL 10600": a 2-4
// letter department followed by a 5-digit number, sometimes run together.
const COURSE_CODE_RE = /\b([A-Za-z]{2,4})\s*(\d{5})\b/

export const MAX_GROUP_TITLE = 120
export const MAX_GROUP_DESCRIPTION = 1000
export const MAX_MEETING_INFO = 200
export const MAX_CAPACITY = 100

/**
 * Extract a normalized course code ("CS 18000") from arbitrary text.
 * @param {unknown} text
 * @returns {string} normalized "DEPT NNNNN", or '' when none is found
 */
export function normalizeCourseCode(text) {
  if (typeof text !== 'string') return ''
  const match = text.match(COURSE_CODE_RE)
  if (!match) return ''
  return `${match[1].toUpperCase()} ${match[2]}`
}

/**
 * Distinct, sorted course codes detected from a user's class calendar items.
 * @param {Array<{ title?: string }>} items
 * @returns {string[]}
 */
export function coursesFromClassItems(items) {
  if (!Array.isArray(items)) return []
  const set = new Set()
  for (const item of items) {
    const code = normalizeCourseCode(item?.title)
    if (code) set.add(code)
  }
  return [...set].sort()
}

/**
 * Validate + coerce a study-group creation body.
 * @returns {{ value: object } | { error: string }}
 */
export function validateStudyGroupInput(body) {
  const courseCode = normalizeCourseCode(body?.courseCode ?? body?.course_code)
  if (!courseCode) {
    return { error: 'A valid course code (e.g. CS 18000) is required' }
  }

  const title = String(body?.title ?? '').trim()
  if (!title || title.length > MAX_GROUP_TITLE) {
    return { error: `Title is required (max ${MAX_GROUP_TITLE} characters)` }
  }

  const description = String(body?.description ?? '').trim().slice(0, MAX_GROUP_DESCRIPTION)
  const meetingInfo = String(body?.meetingInfo ?? body?.meeting_info ?? '').trim().slice(0, MAX_MEETING_INFO)

  let capacity = null
  if (body?.capacity !== undefined && body?.capacity !== null && body?.capacity !== '') {
    const n = Number(body.capacity)
    if (!Number.isInteger(n) || n < 2 || n > MAX_CAPACITY) {
      return { error: `Capacity must be a whole number between 2 and ${MAX_CAPACITY}` }
    }
    capacity = n
  }

  return {
    value: {
      course_code: courseCode,
      title,
      description,
      meeting_info: meetingInfo,
      capacity,
    },
  }
}
