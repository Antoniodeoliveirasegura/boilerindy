import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { authRequest, parseNextPath, resolvePostLoginPath, shouldSkipSetup, setSkipSetup } from './authApi'

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
