// freeFood.mjs
//
// Pure keyword matcher for the Free Food feature (issue #46). Given an event's
// title and description, decide whether it advertises free food. Kept I/O-free
// so the keyword rules are unit-testable, and exported as a single function so
// server.mjs can flag calendar items without duplicating the word list.

// Multi-word phrases and single words that reliably signal free food at a
// campus event. Matched case-insensitively on word boundaries (see below).
export const FREE_FOOD_KEYWORDS = [
  'free food',
  'free pizza',
  'free lunch',
  'free dinner',
  'free breakfast',
  'free snacks',
  'pizza',
  'snacks',
  'refreshments',
  'food provided',
  'lunch provided',
  'dinner provided',
  'breakfast provided',
  'donuts',
  'doughnuts',
  'bagels',
  'catered',
  'catering',
]

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One alternation matched on word boundaries. Phrases keep their internal
// spaces, so "free food" matches "Free Food" but not "freefood".
const MATCHER = new RegExp(
  `\\b(?:${FREE_FOOD_KEYWORDS.map(escapeRegExp).join('|')})\\b`,
  'iu',
)

/**
 * @param {string} [title]
 * @param {string} [description]
 * @returns {boolean} true when the combined text advertises free food.
 */
export function hasFreeFood(title, description) {
  const combined = `${title || ''}\n${description || ''}`
  if (!combined.trim()) return false
  return MATCHER.test(combined.normalize('NFKC'))
}
