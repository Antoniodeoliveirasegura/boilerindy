// Free-text search terms for the PostgREST list routes (lost and found, the
// marketplace). Moved out of server.mjs with the lost-and-found router (issue
// #191) so every router that searches shares one rule.

/**
 * Strip PostgREST filter separators and ILIKE wildcards from free-text search
 * so a crafted `q` can't inject extra `.or()` clauses or abuse %/_ wildcards.
 * Trims the result and caps it at 120 characters; `null` or `undefined` gives ''.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeSearchTerm(value) {
  return String(value ?? '').replace(/[%_,()\\]/g, ' ').trim().slice(0, 120)
}
