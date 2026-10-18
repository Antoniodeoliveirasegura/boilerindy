// The routes that list the shared campus events (issue #30), where AppLayout
// shows no sponsor rails. Ticketmaster's API terms bar deriving revenue from
// the use of its API, so the pages that can carry its listings stay ad-free,
// whichever sources feed them today. Home's own ad slots never show shared
// rows: its calendar read leaves out `shared=1`.
import { normalizeRoutePath } from './routePath'

export const AD_FREE_PATHS = ['/events', '/free-food'] as const

/** True for an ad-free route, in any letter case, with or without a trailing slash. */
export function isAdFreePath(pathname: string): boolean {
  return (AD_FREE_PATHS as readonly string[]).includes(normalizeRoutePath(pathname))
}
