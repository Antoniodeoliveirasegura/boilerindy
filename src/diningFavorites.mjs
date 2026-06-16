// Dining favorites (issue #49 Phase A). Item names come from Nutrislice menus
// and from user input, so they are normalized to a stable key before storage
// and comparison: trimmed, internal whitespace collapsed, lowercased, length
// capped. This makes "Chicken  Tenders" and "chicken tenders" the same favorite.

export const MAX_ITEM_NAME = 200

/**
 * @param {unknown} name
 * @returns {string} normalized favorite key, or '' when the input is unusable
 */
export function normalizeItemName(name) {
  if (typeof name !== 'string') return ''
  return name.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_ITEM_NAME)
}
