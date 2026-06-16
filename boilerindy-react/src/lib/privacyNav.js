// Context-aware back-link target for the privacy page (issue #56). The page is
// reached from the signup disclosure (Login) and from Settings → Privacy, so a
// blanket "/" link would strand users. Callers pass ?from=signup|settings; an
// absent/unknown value falls back to the Landing page (direct visits, deep links).

const BACK_TARGETS = {
  signup: { to: '/login?tab=signup', label: '← Back to sign up' },
  settings: { to: '/settings', label: '← Back to Settings' },
}

/**
 * @param {string | null | undefined} from - the `from` query param on /privacy
 * @returns {{ to: string, label: string }} destination + label for the back link
 */
export function getBackTarget(from) {
  return BACK_TARGETS[from] || { to: '/', label: '← Back to BoilerIndy' }
}
