/**
 * Browser-side localStorage cache for a customizable widget board (issue #219).
 *
 * The home dashboard and the Student Services board used to carry byte-identical
 * copies of this code, differing only in the key prefix and the shared schema
 * module (`src/dashboardLayout.mjs` / `src/servicesLayout.mjs`). The factory
 * keeps the per-user scoping in one place: every key ends with the backend user
 * id and every load/save no-ops without one. Stored values are untrusted and
 * always run through the board's normalizeLayout. The cache is only an
 * offline/optimistic fallback; the DB copy remains the source of truth.
 */

export type LocalLayoutSchema<Layout> = {
  normalizeLayout: (input: unknown) => Layout
}

export type LocalLayoutStore<Layout> = {
  /** Read the cached layout for a user, or null when nothing is cached. */
  loadLocalLayout: (userId: string | null | undefined) => Layout | null
  /** Persist a layout to localStorage for a user. No-ops without a user id. */
  saveLocalLayout: (userId: string | null | undefined, layout: unknown) => void
}

/**
 * @param prefix Key prefix including the trailing separator, e.g.
 *   `boilerindy-dashboard-layout-v1-`; the user id is appended verbatim.
 * @param schema The board's shared validator. Load returns null rather than a
 *   default when nothing is cached; useWidgetLayout applies the board default.
 */
export function createLocalLayoutStore<Layout>(
  prefix: string,
  schema: LocalLayoutSchema<Layout>,
): LocalLayoutStore<Layout> {
  const storageKey = (userId: string) => `${prefix}${userId}`

  function loadLocalLayout(userId: string | null | undefined): Layout | null {
    if (!userId) return null
    try {
      const raw = localStorage.getItem(storageKey(userId))
      if (!raw) return null
      return schema.normalizeLayout(JSON.parse(raw))
    } catch {
      return null
    }
  }

  function saveLocalLayout(userId: string | null | undefined, layout: unknown): void {
    if (!userId) return
    try {
      localStorage.setItem(storageKey(userId), JSON.stringify(layout))
    } catch {
      /* storage unavailable / quota - DB copy remains the source of truth */
    }
  }

  return { loadLocalLayout, saveLocalLayout }
}
