// How a page treats a failed write (issue #202).
//
// authRequest throws an Error carrying the HTTP `status` of the response and
// its parsed `payload`. A write fails in one of two ways, and they need
// different handling:
//
// - The server answered with a 4xx. It is up and refused this one request: a
//   row cap (409), the user-write or advertiser-write limiter (429), a
//   validation error (400), a missing row (404) or a permission check (403).
//   None of those says the server is unreachable, so the page stays online:
//   it undoes what it showed optimistically and shows the server's message.
//   Saving the change on the device instead would keep a copy the account
//   never receives, and the pages with a device-only mode would stop calling
//   the server for every later write.
// - No response came back (offline, DNS, a dropped connection: no `status`),
//   or the server failed with a 5xx (the database is down or a table is
//   missing, which is what the device-only fallbacks were built for). Those
//   keep each page's existing offline behaviour.
//
// A 401 never reaches a page: authRequest sends the browser to sign in first.

type FailedRequest = { status?: unknown; payload?: unknown }

export const TOO_MANY_CHANGES_MESSAGE = 'You are making changes too quickly. Please wait a moment and try again.'

/** The HTTP status of a failed request, or null when no response came back. */
export function responseStatus(err: unknown): number | null {
  const status = (err as FailedRequest | null | undefined)?.status
  return typeof status === 'number' && Number.isFinite(status) && status > 0 ? status : null
}

/** True when the server answered and refused the request (any 4xx). */
export function isServerRefusal(err: unknown): boolean {
  const status = responseStatus(err)
  return status !== null && status >= 400 && status < 500
}

/**
 * What to tell the user about a failed write. A refusal shows the server's own
 * message (the cap and limiter messages say what to do next), or a generic
 * "too quickly" line for a 429 without one. Anything else gets `fallback`: a
 * 5xx message can be a raw database error, and a network failure's is the
 * browser's ("Failed to fetch").
 */
export function writeFailureMessage(err: unknown, fallback: string): string {
  if (!isServerRefusal(err)) return fallback
  const payload = (err as FailedRequest).payload
  if (payload && typeof payload === 'object') {
    const body = payload as { error?: { message?: unknown }; message?: unknown }
    const message = body.error?.message ?? body.message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return responseStatus(err) === 429 ? TOO_MANY_CHANGES_MESSAGE : fallback
}

export type RefusedSave<T> = { restore: T; error: unknown }

/**
 * Bookkeeping for a value the page saves whole on every change (a PUT of the
 * full dashboard layout, the selected major), so a refused save can put back
 * the value the server last accepted.
 *
 * Saves overlap: a student clicking a move arrow three times sends three PUTs,
 * and at the limit the first can still be waiting on the database when the
 * limiter has already refused the third. So only a refusal of the latest save
 * counts (it would have carried every earlier change), and the restore waits
 * until no save is in flight, by which time every accepted save has been
 * recorded. A newer save clears a pending refusal because it carries the whole
 * value again. Network and 5xx failures never restore: the page keeps its
 * offline copy.
 */
export function createWholeValueSaves<T>(initial: T) {
  let accepted = initial
  let acceptedTicket = 0
  let latestTicket = 0
  let inFlight = 0
  let refusal: { error: unknown } | null = null

  function settle(): RefusedSave<T> | null {
    inFlight = Math.max(0, inFlight - 1)
    if (inFlight > 0 || !refusal) return null
    const { error } = refusal
    refusal = null
    return { restore: accepted, error }
  }

  return {
    /** The value the page loaded from the server. Ignored once a save has been accepted. */
    loaded(value: T) {
      if (acceptedTicket === 0) accepted = value
    },
    /** Call just before sending a save; pass the returned ticket to succeeded or failed. */
    start(): number {
      latestTicket += 1
      inFlight += 1
      refusal = null
      return latestTicket
    },
    /** The save with this ticket was accepted. Returns a pending restore, if one is now due. */
    succeeded(ticket: number, value: T): RefusedSave<T> | null {
      if (ticket > acceptedTicket) {
        acceptedTicket = ticket
        accepted = value
      }
      return settle()
    },
    /** The save with this ticket failed. Returns what to restore and the error, when that is now due. */
    failed(ticket: number, err: unknown): RefusedSave<T> | null {
      if (ticket === latestTicket && isServerRefusal(err)) refusal = { error: err }
      return settle()
    },
  }
}
