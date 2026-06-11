/**
 * Persists per-task priority labels (issue #6) in localStorage, keyed by
 * backend user id. Works uniformly for imported calendar items and manual
 * tasks, and survives between sessions on this device.
 */

export const PRIORITY_LEVELS = ['high', 'medium', 'low']

function key(userId) {
  return `boilerindy-task-priority-v1-${userId}`
}

/** @returns {Record<string, 'high'|'medium'|'low'>} itemId -> priority */
export function loadPriorities(userId) {
  if (!userId) return {}
  try {
    const raw = localStorage.getItem(key(userId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const valid = {}
    for (const [id, level] of Object.entries(parsed)) {
      if (PRIORITY_LEVELS.includes(level)) valid[id] = level
    }
    return valid
  } catch {
    return {}
  }
}

/**
 * Set or clear (priority = null) one item's priority.
 * Returns the new map without mutating the previous one.
 */
export function savePriority(userId, itemId, priority) {
  const current = loadPriorities(userId)
  const next = { ...current }
  if (priority && PRIORITY_LEVELS.includes(priority)) {
    next[itemId] = priority
  } else {
    delete next[itemId]
  }
  if (userId) {
    try {
      localStorage.setItem(key(userId), JSON.stringify(next))
    } catch {
      /* quota */
    }
  }
  return next
}
