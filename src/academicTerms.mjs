// academicTerms.mjs
//
// Purdue academic terms as derived from a class meeting's start time, and the
// "which term is the student in right now" pick behind GET /api/me/classes,
// study-group course detection and friend matching. Pure functions (the clock
// is injectable), moved out of server.mjs so the term pick can be tested
// without Postgres (issue #198).
//
// A term key is `<year>-<season>`: January to May is spring, June and July are
// summer, August to December is fall. Dates are read in the server's local
// time, the same way the pick has always worked.

export const TERM_ORDER = { spring: 1, summer: 2, fall: 3 }

// First month (0-based) of each season, matching the ranges in getAcademicTerm.
const TERM_START_MONTH = { spring: 0, summer: 5, fall: 7 }

// The class scan reads this many months back from today. It must cover the
// whole current term (fall, the longest, is five months) plus the previous one,
// so the pick below still sees every term it can choose.
export const CLASS_SCAN_LOOKBACK_MONTHS = 8

function startOfDay(dateValue) {
  const date = new Date(dateValue)
  date.setHours(0, 0, 0, 0)
  return date
}

function termLabel(season, year) {
  return `${season.charAt(0).toUpperCase() + season.slice(1)} ${year}`
}

export function getAcademicTerm(dateValue) {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return null
  const month = date.getMonth()
  const year = date.getFullYear()
  let season = 'fall'
  if (month <= 4) season = 'spring'
  else if (month <= 6) season = 'summer'
  return {
    key: `${year}-${season}`,
    year,
    season,
    label: termLabel(season, year),
  }
}

export function parseTermKey(termKey) {
  const [yearPart, season] = String(termKey || '').split('-')
  const year = Number(yearPart)
  if (!year || !TERM_ORDER[season]) return null
  return { key: `${year}-${season}`, year, season, label: termLabel(season, year) }
}

export function compareTermKeys(a, b) {
  const left = parseTermKey(a)
  const right = parseTermKey(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  if (left.year !== right.year) return left.year - right.year
  return TERM_ORDER[left.season] - TERM_ORDER[right.season]
}

// items are snake_case class rows ({ start_time, end_time }). Prefers the term
// today falls in while it still has meetings ahead, then the soonest upcoming
// term, then the latest term on record.
export function getPreferredClassTerm(items, { now = new Date() } = {}) {
  if (!items.length) return null

  const groups = new Map()
  for (const item of items) {
    const term = getAcademicTerm(item.start_time)
    if (!term) continue
    const start = new Date(item.start_time)
    const end = new Date(item.end_time || item.start_time)
    const current = groups.get(term.key) || {
      key: term.key,
      label: term.label,
      minStart: start,
      maxEnd: end,
    }
    if (start < current.minStart) current.minStart = start
    if (end > current.maxEnd) current.maxEnd = end
    groups.set(term.key, current)
  }

  if (!groups.size) return null

  const today = startOfDay(now)
  const currentTerm = getAcademicTerm(today)
  const currentGroup = currentTerm ? groups.get(currentTerm.key) : null
  if (currentGroup && currentGroup.maxEnd >= today) {
    return parseTermKey(currentGroup.key)
  }

  const upcomingGroups = [...groups.values()]
    .filter((group) => group.maxEnd >= today)
    .sort((a, b) => a.minStart - b.minStart || compareTermKeys(a.key, b.key))
  if (upcomingGroups.length) {
    return parseTermKey(upcomingGroups[0].key)
  }

  const latestGroup = [...groups.values()].sort((a, b) => compareTermKeys(b.key, a.key) || b.maxEnd - a.maxEnd)[0]
  return latestGroup ? parseTermKey(latestGroup.key) : null
}

// Lower bound (ISO string) for the class scan in getClassItemsForUser. An
// unbounded ascending read returns the OLDEST meetings, and PostgREST's
// max-rows cut the current term off entirely for students with a few synced
// semesters (issue #198). An explicit older term key widens the window back to
// that term's first day so ?term=<key> keeps answering with its meetings.
export function classScanFrom(term, { now = new Date() } = {}) {
  const from = startOfDay(now)
  from.setMonth(from.getMonth() - CLASS_SCAN_LOOKBACK_MONTHS)
  const explicit = term && term !== 'auto' && term !== 'all' ? parseTermKey(term) : null
  if (explicit) {
    const termStart = new Date(explicit.year, TERM_START_MONTH[explicit.season], 1)
    if (termStart < from) return termStart.toISOString()
  }
  return from.toISOString()
}
