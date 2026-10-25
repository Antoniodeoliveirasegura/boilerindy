// The app routes a signed-out visitor may open (issue #366): live dining and
// transit, the campus map and the free food on campus calendars, which read
// only session-free data (the map reads Purdue's public building layer
// straight from ArcGIS). App.tsx leaves exactly these without RequireAuth,
// AppLayout shows the preview bar on them instead of the navbar, and
// public/sitemap.xml lists them (publicPreview.test.ts checks both against
// this list).
import { normalizeRoutePath } from './routePath'

export const PREVIEW_PATHS = ['/dining', '/transit', '/map', '/free-food'] as const

export type PreviewPath = (typeof PREVIEW_PATHS)[number]

/** True for a preview route, in any letter case, with or without a trailing slash. */
export function isPreviewPath(pathname: string): boolean {
  return (PREVIEW_PATHS as readonly string[]).includes(normalizeRoutePath(pathname))
}

// What the bar says, kept here so the bar and its tests share one copy: what
// the visitor is looking at, and what an account adds on that page. The map
// links from each class on the schedule and Home, and Free Food adds the
// events of the student's own calendar to the campus ones.
export const PREVIEW_MESSAGE =
  "You're previewing live campus data. Create a free account to save favorites and get stop alerts."

export const PREVIEW_MESSAGES: Record<PreviewPath, string> = {
  '/dining': PREVIEW_MESSAGE,
  '/transit': PREVIEW_MESSAGE,
  '/map': "You're previewing the campus map. Create a free account to find each of your classes on it.",
  '/free-food': "You're previewing free food on campus. Create a free account to add events from your own calendar.",
}

/** The bar's message on a preview route; the dining and transit one anywhere else. */
export function previewMessage(pathname: string): string {
  return PREVIEW_MESSAGES[normalizeRoutePath(pathname) as PreviewPath] ?? PREVIEW_MESSAGE
}

/**
 * "Create account" opens the sign-up tab with no `next`: a new account goes
 * through /setup, and a `next` would skip it.
 */
export const PREVIEW_SIGN_UP_HREF = '/login?tab=signup'

/** "Sign in" comes back to the page the visitor was previewing. */
export function previewSignInHref(pathname: string, search = ''): string {
  return `/login?next=${encodeURIComponent(pathname + search)}`
}
