// Share links (the Share buttons on /transit and /dining, docs/share-links.md).
// A link a student drops in a group chat reopens the view they were looking
// at, for a friend who is signed out too (the public preview, issue #366), and
// carries a `ref` that says where the visit came from. The sign-up form
// records that ref; this module only builds the address.

export type SharePage = 'transit' | 'dining'

/** Each page's ref: a slug of [a-z0-9-] of at most 40 characters, as the sign-up source accepts. */
export const SHARE_REFS: Record<SharePage, string> = { transit: 'share-bus', dining: 'share-dining' }

const SHARE_PATHS: Record<SharePage, string> = { transit: '/transit', dining: '/dining' }

// The parts of the address that make up each page's view: the route on
// /transit, the hall and meal on /dining. Anything else there (an earlier ref,
// utm tags, another app's click id) stays out of a shared link.
const VIEW_PARAMS: Record<SharePage, readonly string[]> = { transit: ['route'], dining: ['hall', 'meal'] }

export type ShareView = Record<string, string | null | undefined>

/**
 * The link that shares `page` from `current`, the address on screen: its
 * origin and view, a value in `view` in place of the address's own (null or
 * undefined leaves that part out), and this page's ref in place of any ref
 * already there. Dining passes the hall and meal it shows, since those are
 * not in the address until a student picks one.
 */
export function shareUrl(page: SharePage, current: string, view: ShareView = {}): string {
  const from = new URL(current)
  const to = new URL(SHARE_PATHS[page], from.origin)
  for (const key of VIEW_PARAMS[page]) {
    const value = key in view ? view[key] : from.searchParams.get(key)
    if (value) to.searchParams.set(key, value)
  }
  to.searchParams.set('ref', SHARE_REFS[page])
  return to.toString()
}
