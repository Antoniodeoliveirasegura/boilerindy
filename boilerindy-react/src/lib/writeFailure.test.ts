import { describe, expect, it } from 'vitest'
import {
  TOO_MANY_CHANGES_MESSAGE,
  createWholeValueSaves,
  isServerRefusal,
  responseStatus,
  writeFailureMessage,
} from './writeFailure'

// Issue #202: a 4xx is the server refusing one write (the page stays online),
// no response or a 5xx is the offline case each page already handles.

/** The error authRequest throws for a non-2xx response. */
function httpError(status: number, payload: unknown = { error: { message: `status ${status}`, status } }) {
  const message =
    payload && typeof payload === 'object'
      ? String((payload as { error?: { message?: string } }).error?.message ?? 'Request failed')
      : 'Request failed'
  return Object.assign(new Error(message), { status, payload })
}

const networkError = () => new TypeError('Failed to fetch')

describe('isServerRefusal', () => {
  it('treats every 4xx as a refusal from a reachable server', () => {
    for (const status of [400, 403, 404, 409, 429]) expect(isServerRefusal(httpError(status))).toBe(true)
  })

  it('treats no response and 5xx as offline', () => {
    expect(isServerRefusal(networkError())).toBe(false)
    for (const status of [500, 502, 503]) expect(isServerRefusal(httpError(status))).toBe(false)
    expect(isServerRefusal(null)).toBe(false)
    expect(isServerRefusal({ status: '429' })).toBe(false)
    expect(responseStatus(networkError())).toBeNull()
  })
})

describe('writeFailureMessage', () => {
  it("shows the server's message for a cap or limiter refusal", () => {
    const cap = httpError(409, { error: { message: 'You can keep up to 500 tasks.', status: 409 } })
    expect(writeFailureMessage(cap, 'fallback')).toBe('You can keep up to 500 tasks.')
    const limited = httpError(429, { error: { message: 'Slow down.', status: 429, retryAfterSeconds: 30 } })
    expect(writeFailureMessage(limited, 'fallback')).toBe('Slow down.')
  })

  it('falls back to a "too quickly" line for a 429 without a JSON message', () => {
    expect(writeFailureMessage(httpError(429, '<html>Too Many Requests</html>'), 'fallback')).toBe(
      TOO_MANY_CHANGES_MESSAGE,
    )
    expect(writeFailureMessage(httpError(409, ''), 'fallback')).toBe('fallback')
  })

  it('never shows a 5xx or network message, which can be a raw database or browser error', () => {
    expect(writeFailureMessage(httpError(500, { error: { message: 'relation does not exist' } }), 'fallback')).toBe(
      'fallback',
    )
    expect(writeFailureMessage(networkError(), 'fallback')).toBe('fallback')
  })
})

describe('createWholeValueSaves', () => {
  it('restores the last accepted value when the only save is refused', () => {
    const saves = createWholeValueSaves('a')
    saves.loaded('b')
    const ticket = saves.start()
    const refused = saves.failed(ticket, httpError(429))
    expect(refused?.restore).toBe('b')
    expect(responseStatus(refused?.error)).toBe(429)
  })

  it('keeps the offline copy when a save gets no response or a 5xx', () => {
    const saves = createWholeValueSaves('a')
    expect(saves.failed(saves.start(), networkError())).toBeNull()
    expect(saves.failed(saves.start(), httpError(503))).toBeNull()
  })

  it('waits for a slower accepted save before restoring past a refused newer one', () => {
    const saves = createWholeValueSaves('a')
    const first = saves.start() // 'b', still waiting on the database
    const second = saves.start() // 'c', refused by the limiter straight away
    expect(saves.failed(second, httpError(429))).toBeNull()
    expect(saves.succeeded(first, 'b')).toEqual({ restore: 'b', error: expect.any(Error) })
  })

  it('ignores a refusal a newer save supersedes, since that save carries the whole value', () => {
    const saves = createWholeValueSaves('a')
    const first = saves.start()
    const second = saves.start()
    expect(saves.failed(first, httpError(429))).toBeNull()
    expect(saves.succeeded(second, 'c')).toBeNull()

    const third = saves.start()
    const fourth = saves.start()
    expect(saves.failed(third, httpError(429))).toBeNull()
    expect(saves.failed(fourth, httpError(429))?.restore).toBe('c')
  })

  it('does not let a late load overwrite a value a save already confirmed', () => {
    const saves = createWholeValueSaves('a')
    expect(saves.succeeded(saves.start(), 'b')).toBeNull()
    saves.loaded('stale')
    expect(saves.failed(saves.start(), httpError(429))?.restore).toBe('b')
  })
})
