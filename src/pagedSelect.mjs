// pagedSelect.mjs
//
// Supabase's PostgREST caps every response at `max-rows` (1000 on hosted
// projects) and truncates SILENTLY: `.limit(5000)` still returns 1000 rows and
// no error, so a caller that expects the whole set quietly works on a prefix of
// it (issue #198). Reads that genuinely need more than one response's worth of
// rows page through the result with `.range()` instead.
//
// makeQuery(from, to) must return a FRESH PostgREST builder for every page (a
// builder is spent once awaited); this helper applies `.range(from, to)` to it.
// The query needs a deterministic order (for example start_time, then id) or
// rows can repeat or go missing across page boundaries.
//
// Paging stops on the first page shorter than requested, or once `max` rows
// have arrived. pageSize must not exceed the server's max-rows, or every page
// comes back short and the loop stops after the first one.

export const DEFAULT_PAGE_SIZE = 1000
export const DEFAULT_MAX_ROWS = 5000

/**
 * @param {(from: number, to: number) => { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null, error: unknown }> }} makeQuery
 * @param {{ pageSize?: number, max?: number }} [options]
 * @returns {Promise<{ data: unknown[] | null, error: unknown }>} every row up to `max`, or the first page error
 */
export async function fetchAllPages(makeQuery, { pageSize = DEFAULT_PAGE_SIZE, max = DEFAULT_MAX_ROWS } = {}) {
  const size = Math.max(1, Math.trunc(Number(pageSize)) || DEFAULT_PAGE_SIZE)
  const cap = Math.max(0, Math.trunc(Number(max)) || 0)
  const rows = []

  while (rows.length < cap) {
    const from = rows.length
    const to = Math.min(from + size, cap) - 1
    const { data, error } = await makeQuery(from, to).range(from, to)
    // A failed page fails the whole read: a partial prefix is exactly the
    // silent truncation this helper exists to avoid.
    if (error) return { data: null, error }
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < to - from + 1) break
  }

  return { data: rows.slice(0, cap), error: null }
}
