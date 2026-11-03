import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  authRequest,
  calendarRemindersOff,
  parseNextPath,
  registerSupabaseUser,
  resolvePostLoginPath,
  safeNextPath,
  saveCalendarRemindersOff,
  shouldSkipSetup,
  setSkipSetup,
  skipSetupToCarryOver,
  stopCalendarReminders,
} from './authApi'
import { captureSignupRef, readSignupRef } from './signupRef'

// Issues #23 (post-login redirect) and #40 (skip the connect-sources screen).
beforeEach(() => localStorage.clear())

describe('parseNextPath', () => {
  test('returns the next param when it is a safe relative path', () => {
    expect(parseNextPath('?next=/board')).toBe('/board')
  })

  test('ignores a non-relative next (open-redirect guard)', () => {
    expect(parseNextPath('?next=https://evil.example.com')).toBe('/setup')
  })

  test('defaults to /setup when there is no next and setup is not skipped', () => {
    expect(parseNextPath('')).toBe('/setup')
  })

  test('defaults to /dashboard when the user chose to skip setup', () => {
    setSkipSetup(true)
    expect(parseNextPath('')).toBe('/dashboard')
  })

  test('an explicit next still wins over the skip flag', () => {
    setSkipSetup(true)
    expect(parseNextPath('?next=/board')).toBe('/board')
  })
})

describe('safeNextPath', () => {
  test('keeps a same-site path with its query and hash', () => {
    expect(safeNextPath('/board?post=p3')).toBe('/board?post=p3')
    expect(safeNextPath('/map?building=ET#info')).toBe('/map?building=ET#info')
  })

  test('rejects anything that would leave the site or is not a path', () => {
    for (const next of [null, undefined, '', 'board', 'https://evil.example', '//evil.example', '/\\evil.example']) {
      expect(safeNextPath(next)).toBeNull()
    }
  })

  // A tab or newline is dropped by URL parsing, so these became
  // "//evil.example/x" after a prefix check had passed them, and React Router
  // threw on the navigate, crashing the app on every visit to the link.
  test('rejects a path that only turns protocol-relative once tabs and newlines are dropped', () => {
    for (const ch of ['\t', '\n', '\r']) {
      expect(safeNextPath(`/${ch}/evil.example/x`)).toBeNull()
    }
    expect(parseNextPath('?next=%2F%09%2Fevil.example%2Fx')).toBe('/setup')
  })

  // Dot segments can leave a same-origin URL whose path starts with "//".
  test('rejects a path that only turns protocol-relative once dot segments are resolved', () => {
    for (const next of ['/.//evil.example', '/..//evil.example', '/../..//evil.example', '/%2e//evil.example', '/a/..//evil.example']) {
      expect(safeNextPath(next)).toBeNull()
    }
    expect(parseNextPath('?next=%2F..%2F%2Fevil.example')).toBe('/setup')
  })

  test('rejects /login itself, in any case or with a trailing slash, so sign-in does not land on its own form', () => {
    for (const next of ['/login', '/LOGIN', '/login/', '/login?tab=signup']) {
      expect(safeNextPath(next)).toBeNull()
    }
    expect(resolvePostLoginPath('?next=%2F%0A%2Fevil.example', { needsScheduleSource: false })).toBe('/dashboard')
  })
})

describe('skip-setup flag', () => {
  test('defaults to not skipped', () => {
    expect(shouldSkipSetup()).toBe(false)
  })

  test('can be set and cleared', () => {
    setSkipSetup(true)
    expect(shouldSkipSetup()).toBe(true)
    setSkipSetup(false)
    expect(shouldSkipSetup()).toBe(false)
  })
})

describe('resolvePostLoginPath', () => {
  test('sends a student with a connected schedule to the dashboard', () => {
    expect(resolvePostLoginPath('', { needsScheduleSource: false })).toBe('/dashboard')
  })

  test('sends a student who still needs a schedule source to setup', () => {
    expect(resolvePostLoginPath('', { needsScheduleSource: true })).toBe('/setup')
    expect(resolvePostLoginPath('', null)).toBe('/setup')
    expect(resolvePostLoginPath('', undefined)).toBe('/setup')
  })

  test('the skip flag and a safe next param still apply', () => {
    setSkipSetup(true)
    expect(resolvePostLoginPath('', { needsScheduleSource: true })).toBe('/dashboard')
    expect(resolvePostLoginPath('?next=/board', { needsScheduleSource: false })).toBe('/board')
    expect(resolvePostLoginPath('?next=//evil.example.com', { needsScheduleSource: false })).toBe('/dashboard')
  })

  test("reads calendar reminders from the account (Antoniodeoliveirasegura/boilerindy-app#150)", () => {
    expect(resolvePostLoginPath('', { needsScheduleSource: true }, { calendarRemindersOff: true })).toBe('/dashboard')
    expect(resolvePostLoginPath('', { needsScheduleSource: true }, { calendarRemindersOff: false })).toBe('/setup')
    expect(resolvePostLoginPath('?next=/board', { needsScheduleSource: true }, { calendarRemindersOff: true })).toBe('/board')
    // A "Don't ask again" this browser holds that the account lacks still counts.
    setSkipSetup(true)
    expect(resolvePostLoginPath('', { needsScheduleSource: true }, { calendarRemindersOff: false })).toBe('/dashboard')
  })
})

// Calendar reminders (Antoniodeoliveirasegura/boilerindy-app#150): the account
// keeps the choice, and this browser's pih-skip-setup, which an older tab
// still reads, stands in until the account has it.
describe('calendar reminders', () => {
  function jsonResponse(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  const answered = (off: boolean) =>
    vi.fn().mockImplementation(async () => jsonResponse(200, { user: { id: 'u1', calendarRemindersOff: off } }))
  const notSetUp = () =>
    vi.fn().mockImplementation(async () =>
      jsonResponse(503, {
        error: {
          message: 'The calendar reminders setting is not set up yet. Please try again later.',
          code: 'calendar_reminders_schema_missing',
          status: 503,
        },
      }),
    )

  afterEach(() => vi.unstubAllGlobals())

  test('the account decides once it sends the flag', () => {
    expect(calendarRemindersOff({ calendarRemindersOff: true })).toBe(true)
    expect(calendarRemindersOff({ calendarRemindersOff: false })).toBe(false)
  })

  test('without the flag from the API, this browser decides, as before', () => {
    expect(calendarRemindersOff({})).toBe(false)
    expect(calendarRemindersOff(null)).toBe(false)
    setSkipSetup(true)
    expect(calendarRemindersOff({})).toBe(true)
    expect(calendarRemindersOff(undefined)).toBe(true)
  })

  test('saving sends the choice and copies it to this browser for an older tab', async () => {
    const fetchMock = answered(true)
    vi.stubGlobal('fetch', fetchMock)
    await saveCalendarRemindersOff(true)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/me/profile')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ calendarRemindersOff: true }) })
    expect(shouldSkipSetup()).toBe(true)
    // The account has the choice now, so turning reminders back on in the app wins.
    expect(calendarRemindersOff({ calendarRemindersOff: false })).toBe(false)

    vi.stubGlobal('fetch', answered(false))
    await saveCalendarRemindersOff(false)
    expect(shouldSkipSetup()).toBe(false)
  })

  test('a refused save changes nothing in this browser', async () => {
    vi.stubGlobal('fetch', notSetUp())
    await expect(saveCalendarRemindersOff(true)).rejects.toMatchObject({ status: 503, code: 'calendar_reminders_schema_missing' })
    expect(shouldSkipSetup()).toBe(false)
    expect(calendarRemindersOff({ calendarRemindersOff: false })).toBe(false)
  })

  test("Setup's Don't ask again holds in this browser at once, and after a refused save", async () => {
    // Saved and turned back on earlier, so this browser's flag had reached the account.
    vi.stubGlobal('fetch', answered(true))
    await saveCalendarRemindersOff(true)
    vi.stubGlobal('fetch', answered(false))
    await saveCalendarRemindersOff(false)

    vi.stubGlobal('fetch', notSetUp())
    const saving = stopCalendarReminders()
    expect(shouldSkipSetup()).toBe(true)
    await expect(saving).rejects.toMatchObject({ code: 'calendar_reminders_schema_missing' })
    expect(calendarRemindersOff({ calendarRemindersOff: false })).toBe(true)
    expect(skipSetupToCarryOver({ calendarRemindersOff: false })).toBe(true)
  })

  test('an API from before the switch answers without the flag, so this browser keeps the choice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { items: [], ok: true })))
    await stopCalendarReminders()
    expect(calendarRemindersOff({})).toBe(true)
    expect(calendarRemindersOff({ calendarRemindersOff: false })).toBe(true)
    expect(skipSetupToCarryOver({ calendarRemindersOff: false })).toBe(true)
  })

  test('only a browser flag the account lacks is carried over, and an account that has it settles the flag', () => {
    expect(skipSetupToCarryOver({ calendarRemindersOff: false })).toBe(false)
    setSkipSetup(true)
    expect(skipSetupToCarryOver({})).toBe(false)
    expect(skipSetupToCarryOver(null)).toBe(false)
    expect(skipSetupToCarryOver({ calendarRemindersOff: false })).toBe(true)
    expect(skipSetupToCarryOver({ calendarRemindersOff: true })).toBe(false)
    // The account had it, so turning reminders back on in the app wins over the old flag.
    expect(skipSetupToCarryOver({ calendarRemindersOff: false })).toBe(false)
    expect(calendarRemindersOff({ calendarRemindersOff: false })).toBe(false)
  })
})

// Issue #218: the API's error.code rides on the thrown error so a page can
// branch on it (for example code.endsWith('_schema_missing') for "coming soon").
describe('authRequest errors', () => {
  function jsonResponse(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('copies error.code, status and payload onto the thrown error', async () => {
    const body = {
      error: {
        message: 'The marketplace is not set up yet. Please try again later.',
        code: 'marketplace_schema_missing',
        status: 503,
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(503, body)))
    await expect(authRequest('/api/marketplace')).rejects.toMatchObject({
      message: 'The marketplace is not set up yet. Please try again later.',
      status: 503,
      code: 'marketplace_schema_missing',
      payload: body,
    })
  })

  test('leaves code unset when the answer has none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(500, { error: { message: 'Could not load deals. Please try again.', status: 500 } })),
    )
    const error = await authRequest('/api/deals').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ status: 500, message: 'Could not load deals. Please try again.' })
    expect(error).not.toHaveProperty('code')
  })

  test('ignores a non-string code and a plain-text body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(503, { error: { message: 'Nope', code: 42, status: 503 } })),
    )
    await expect(authRequest('/api/guide').catch((e: unknown) => e)).resolves.not.toHaveProperty('code')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })))
    const error = await authRequest('/api/guide').catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 502, message: 'Bad gateway' })
    expect(error).not.toHaveProperty('code')
  })
})

// The sign-up source (docs/analytics.md): an email sign-up carries the ref the
// tab holds, and drops it once the account exists.
describe('registerSupabaseUser and the sign-up source', () => {
  const created = { session: { user: { id: 'u1', email: 'new@example.com' } } }
  function jsonResponse(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  const sentBody = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(fetchMock.mock.calls[0][1].body as string)

  beforeEach(() => sessionStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  test('sends the held ref with the new account, then forgets it', async () => {
    captureSignupRef('?ref=amb-jane')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, created))
    vi.stubGlobal('fetch', fetchMock)
    await expect(registerSupabaseUser('new@example.com', 'a long password', 'New', true)).resolves.toEqual(created)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/register-supabase')
    expect(sentBody(fetchMock)).toEqual({
      email: 'new@example.com',
      password: 'a long password',
      name: 'New',
      rememberMe: true,
      signupRef: 'amb-jane',
    })
    expect(readSignupRef()).toBeNull()
  })

  test('sends no ref field when the tab holds none', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, created))
    vi.stubGlobal('fetch', fetchMock)
    await registerSupabaseUser('new@example.com', 'a long password', 'New')
    expect(sentBody(fetchMock)).not.toHaveProperty('signupRef')
  })

  test('keeps the ref when the sign-up is refused, so the retry still carries it', async () => {
    captureSignupRef('?ref=flyer-b')
    const refused = { error: { message: 'An account with that email already exists.', status: 400 } }
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(400, refused)).mockResolvedValueOnce(jsonResponse(201, created))
    vi.stubGlobal('fetch', fetchMock)
    await expect(registerSupabaseUser('taken@example.com', 'a long password', 'New')).rejects.toThrow('already exists')
    expect(readSignupRef()).toBe('flyer-b')
    await registerSupabaseUser('new@example.com', 'a long password', 'New')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).signupRef).toBe('flyer-b')
    expect(readSignupRef()).toBeNull()
  })
})
