import { beforeEach, describe, expect, test } from 'vitest'
import { parseNextPath, resolvePostLoginPath, shouldSkipSetup, setSkipSetup } from './authApi'

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
