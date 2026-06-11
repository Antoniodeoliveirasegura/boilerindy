/**
 * Filters calendar/class rows that duplicate real lectures (Zoom/Teams shells,
 * generic "Online Meeting") or exam-only rows. Used on Home and Class Schedule.
 */

export function isLikelyExamItem(item) {
  if (item == null || typeof item !== 'object') return false
  const haystack = `${item.title || ''} ${item.description || ''}`.toLowerCase()
  return /\b(midterm|final|exam|quiz|test)\b/.test(haystack)
}

export function isOnlineMeetingNoise(item) {
  if (item == null || typeof item !== 'object') return false
  const title = (item.title || '').toLowerCase()
  const haystack = `${title} ${item.description || ''} ${item.location || ''}`.toLowerCase()
  if (/\b(zoom|teams meeting|webex|microsoft teams|google meet)\b/.test(haystack)) return true
  if (/\bonline\b/.test(title)) return true
  if (/\b(synchronous online|online meeting|online session)\b/.test(haystack)) return true
  return false
}

export function shouldExcludeFromSchedule(item) {
  if (item == null || typeof item !== 'object') return true
  return isLikelyExamItem(item) || isOnlineMeetingNoise(item)
}

export function isLikelyClassMeeting(item) {
  if (item == null || typeof item !== 'object') return false
  if (shouldExcludeFromSchedule(item)) return false
  const haystack = `${item.description || ''} ${item.title || ''}`.toLowerCase()
  return /\b(lecture|laboratory|lab|recitation|discussion|seminar|studio|practicum|clinic|workshop)\b/.test(
    haystack,
  )
}

function getRecurringClassItems(items) {
  const patterns = new Map()

  for (const item of items || []) {
    if (shouldExcludeFromSchedule(item)) continue
    const start = new Date(item.startTime)
    const end = item.endTime ? new Date(item.endTime) : null
    const key = [
      item.title || '',
      item.description || '',
      item.location || '',
      start.getDay(),
      start.getHours(),
      start.getMinutes(),
      end?.getHours() || '',
      end?.getMinutes() || '',
    ].join('|')

    const group = patterns.get(key) || []
    group.push(item)
    patterns.set(key, group)
  }

  const recurringItems = [...patterns.values()]
    .filter((group) => group.length > 1)
    .flat()

  if (recurringItems.length) {
    return recurringItems
  }

  return (items || []).filter((item) => !shouldExcludeFromSchedule(item))
}

export function getHomeClassItems(items) {
  const meetingTypeItems = (items || []).filter((item) => isLikelyClassMeeting(item))
  if (meetingTypeItems.length) {
    return meetingTypeItems
  }

  const recurringItems = getRecurringClassItems(items)
  if (recurringItems.length) {
    return recurringItems
  }

  const clean = (items || []).filter((item) => item != null && !shouldExcludeFromSchedule(item))
  const safeRaw = (items || []).filter((item) => item != null && typeof item === 'object')
  return clean.length ? clean : safeRaw
}

/** Class Schedule page: drop noise rows; keep all other meetings (not the stricter Home heuristic). */
export function filterClassItemsForSchedulePage(items) {
  return (items || []).filter((item) => item != null && !shouldExcludeFromSchedule(item))
}
