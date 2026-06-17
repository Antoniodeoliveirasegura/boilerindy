// Context-aware back-link target for the privacy page (issue #56). The page is
// reached from the signup disclosure (Login) and from Settings → Privacy, so a
// blanket "/" link would strand users. Callers pass ?from=signup|settings; an
// absent/unknown value falls back to the Landing page (direct visits, deep links).
// Migrated to TypeScript as part of the incremental TS migration (issue #20).

export type BackTarget = { to: string; label: string }

const BACK_TARGETS: Record<string, BackTarget> = {
  signup: { to: '/login?tab=signup', label: '← Back to sign up' },
  settings: { to: '/settings', label: '← Back to Settings' },
}

export function getBackTarget(from: string | null | undefined): BackTarget {
  return BACK_TARGETS[from ?? ''] ?? { to: '/', label: '← Back to BoilerIndy' }
}
