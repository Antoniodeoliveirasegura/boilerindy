import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { localIsoDate, startOfWeek } from './localDate'

// The new-task due date on the Assignments page and the per-day / per-week AI
// cache keys must follow the local calendar, not UTC. The process is pinned to
// Seoul (UTC+9), where just after local midnight the UTC date is still the
// previous day: the exact case that sent a freshly added task straight into
// "past items". vi.stubEnv writes process.env.TZ, which Node applies to Date
// at once; each file runs in its own forked process and the stub is undone
// after every test, so the zone cannot leak into other suites.

// 00:30 on Wednesday 2026-09-09 in Seoul, which is 15:30 on the 8th in UTC.
const SEOUL_JUST_AFTER_MIDNIGHT = new Date('2026-09-09T00:30:00+09:00')

beforeEach(() => {
  vi.stubEnv('TZ', 'Asia/Seoul')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('localIsoDate', () => {
  test('runs on UTC+9, so the local and UTC dates disagree after midnight', () => {
    expect(SEOUL_JUST_AFTER_MIDNIGHT.getTimezoneOffset()).toBe(-540)
  })

  test('uses the local calendar day just after midnight east of UTC', () => {
    vi.useFakeTimers()
    vi.setSystemTime(SEOUL_JUST_AFTER_MIDNIGHT)

    expect(localIsoDate()).toBe('2026-09-09')
    // What the old toISOString().slice(0, 10) default produced at that moment.
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-08')
  })

  test('formats an explicit date with zero-padded month and day', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05')
    expect(localIsoDate(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })

  test('stays on the local day in the Indianapolis evening, west of UTC', () => {
    vi.stubEnv('TZ', 'America/Indiana/Indianapolis')
    // 21:00 EDT on Tuesday 2026-09-08 is already 01:00 on the 9th in UTC.
    const indyEvening = new Date('2026-09-08T21:00:00-04:00')
    expect(indyEvening.getTimezoneOffset()).toBe(240)
    vi.useFakeTimers()
    vi.setSystemTime(indyEvening)

    expect(localIsoDate()).toBe('2026-09-08')
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-09')
  })
})

describe('startOfWeek', () => {
  test('returns the Monday of the current local week by default', () => {
    vi.useFakeTimers()
    vi.setSystemTime(SEOUL_JUST_AFTER_MIDNIGHT)

    expect(localIsoDate(startOfWeek())).toBe('2026-09-07')
  })

  test('maps Monday to itself and Sunday to the Monday six days earlier', () => {
    expect(localIsoDate(startOfWeek(new Date(2026, 8, 7, 0, 30)))).toBe('2026-09-07')
    expect(localIsoDate(startOfWeek(new Date(2026, 8, 13, 23, 0)))).toBe('2026-09-07')
  })

  test('rolls back across a month boundary', () => {
    // Thursday 2026-10-01 belongs to the week of Monday 2026-09-28.
    expect(localIsoDate(startOfWeek(new Date(2026, 9, 1, 9, 0)))).toBe('2026-09-28')
  })

  test('does not mutate its argument', () => {
    const input = new Date(2026, 8, 9, 0, 30)
    const before = input.getTime()
    startOfWeek(input)
    expect(input.getTime()).toBe(before)
  })
})
