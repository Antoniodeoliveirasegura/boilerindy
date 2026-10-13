// The app routes a signed-out visitor may open (issue #366): live dining and
// transit, which read only the session-free public data. App.tsx leaves
// exactly these without RequireAuth, AppLayout shows the preview bar on them
// instead of the navbar, and public/sitemap.xml lists them
// (publicPreview.test.ts checks that last one against this list).
import { normalizeRoutePath } from './routePath'

export const PREVIEW_PATHS = ['/dining', '/transit'] as const

/** True for a preview route, in any letter case, with or without a trailing slash. */
export function isPreviewPath(pathname: string): boolean {
  return (PREVIEW_PATHS as readonly string[]).includes(normalizeRoutePath(pathname))
}

// What the bar says, kept here so the bar and its tests share one copy.
export const PREVIEW_MESSAGE =
  "You're previewing live campus data. Create a free account to save favorites and get stop alerts."

/**
 * "Create account" opens the sign-up tab with no `next`: a new account goes
 * through /setup, and a `next` would skip it.
 */
export const PREVIEW_SIGN_UP_HREF = '/login?tab=signup'

/** "Sign in" comes back to the page the visitor was previewing. */
export function previewSignInHref(pathname: string, search = ''): string {
  return `/login?next=${encodeURIComponent(pathname + search)}`
}
