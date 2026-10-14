// Context-aware back-link target for the privacy page (issue #56). The page is
// reached from the signup disclosure (Login) and from Settings → Privacy, so a
// blanket "/" link would strand users. Callers pass ?from=signup|settings; an
// absent/unknown value falls back to the Landing page (direct visits, deep links),
// or to the dashboard for a signed-in student.
// Migrated to TypeScript as part of the incremental TS migration (issue #20).
//
// Terms, Support, Delete account and Install use it too. Install is also opened
// from the sign-in page, which passes ?from=signin: its header used to say
// "Back to sign in" to everyone, so a visitor from the landing page or a
// student from Settings was sent to /login instead of back where they were.

export type BackTarget = { to: string; label: string }

const BACK_TARGETS: Record<string, BackTarget> = {
  signup: { to: '/login?tab=signup', label: '← Back to sign up' },
  signin: { to: '/login', label: '← Back to sign in' },
  settings: { to: '/settings', label: '← Back to Settings' },
}

// Own keys only: a plain lookup handed ?from=constructor the Object
// constructor, a "target" with no `to` or `label`.
function isKnownFrom(from: string | null | undefined): from is string {
  return from != null && Object.hasOwn(BACK_TARGETS, from)
}

// The app footer's Terms, Privacy and Support links carry no `from`, and "/"
// is the marketing page, which treats a signed-in student as a visitor. So
// with no usable `from`, a signed-in student goes back into the app instead.
export function getBackTarget(from: string | null | undefined, signedIn = false): BackTarget {
  if (isKnownFrom(from)) return BACK_TARGETS[from]
  return { to: signedIn ? '/dashboard' : '/', label: '← Back to BoilerIndy' }
}

// The legal pages link to each other (Privacy → Delete account, Terms →
// Support, the footer on each). Those links pass the incoming `from` on, or
// Settings → Privacy → Delete account would lose "Back to Settings" on the
// second page. Only values getBackTarget knows are passed on, so a junk
// ?from= stops at the page it was typed on.
export function withFrom(to: string, from: string | null | undefined): string {
  if (!isKnownFrom(from)) return to
  return `${to}${to.includes('?') ? '&' : '?'}from=${from}`
}
