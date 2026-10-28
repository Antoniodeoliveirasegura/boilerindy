// Share links (the Share buttons on /transit, /dining and /free-food,
// docs/share-links.md). A link a student drops in a group chat reopens the
// view they were looking at, for a friend who is signed out too (the public
// preview, issue #366), and carries a `ref` that says where the visit came
// from. The sign-up form records that ref; this module only builds the address.

export type SharePage = 'transit' | 'dining' | 'free-food'

/** Each page's ref: a slug of [a-z0-9-] of at most 40 characters, as the sign-up source accepts. */
export const SHARE_REFS: Record<SharePage, string> = { transit: 'share-bus', dining: 'share-dining', 'free-food': 'share-free-food' }

/** How a link leaves the page: sent as a link (Share), or shown as a QR code for someone to scan. */
export type ShareVia = 'link' | 'qr'

/** Each page's ref in a QR code, so a sign-up from a scan counts apart from one from a chat. */
export const QR_REFS: Record<SharePage, string> = { transit: 'qr-bus', dining: 'qr-dining', 'free-food': 'qr-free-food' }

const SHARE_PATHS: Record<SharePage, string> = { transit: '/transit', dining: '/dining', 'free-food': '/free-food' }

// The parts of the address that make up each page's view: the route on
// /transit, the hall and meal on /dining, the one event on /free-food.
// Anything else there (an earlier ref, utm tags, another app's click id) stays
// out of a shared link.
const VIEW_PARAMS: Record<SharePage, readonly string[]> = { transit: ['route'], dining: ['hall', 'meal'], 'free-food': ['event'] }

export type ShareView = Record<string, string | null | undefined>

/**
 * The link that shares `page` from `current`, the address on screen: its
 * origin and view, a value in `view` in place of the address's own (null or
 * undefined leaves that part out), and this page's ref in place of any ref
 * already there. Dining passes the hall and meal it shows, since those are
 * not in the address until a student picks one. `via` 'qr' puts the page's
 * QR ref there instead; a share link passed as `current` keeps its view.
 */
export function shareUrl(page: SharePage, current: string, view: ShareView = {}, via: ShareVia = 'link'): string {
  const from = new URL(current)
  const to = new URL(SHARE_PATHS[page], from.origin)
  for (const key of VIEW_PARAMS[page]) {
    const value = key in view ? view[key] : from.searchParams.get(key)
    if (value) to.searchParams.set(key, value)
  }
  to.searchParams.set('ref', via === 'qr' ? QR_REFS[page] : SHARE_REFS[page])
  return to.toString()
}

// A shared campus event is listed as `campus:<id>` both signed in and signed
// out (toSharedCalendarItem in src/campusEventsFeed.mjs), so one link finds it
// for either. The link carries the id alone. A student's own calendar rows
// have no such id: a friend could never see them, so they are never shared.
const CAMPUS_EVENT_PREFIX = 'campus:'

/** The `event` a free-food link names for a listed row: its campus id, or null for a row that is not a shared campus event. */
export function eventLinkParam(itemId: string): string | null {
  if (!itemId.startsWith(CAMPUS_EVENT_PREFIX)) return null
  return itemId.slice(CAMPUS_EVENT_PREFIX.length) || null
}

/** The listed row a free-food link's `event` names, or null when the link names none. */
export function linkedEventId(param: string | null): string | null {
  const id = param?.trim()
  return id ? `${CAMPUS_EVENT_PREFIX}${id}` : null
}
