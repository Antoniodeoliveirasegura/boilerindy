import { describe, expect, test } from 'vitest'
import { dueSoonLabel } from './urgency'

// The urgent badge on Home's Tasks due card and on Assignments: open and due
// within 24 hours reads "Due in Nh" (hours rounded up, at least 1). Overdue
// items used to read "1h left" on Home; they get no label now.

const NOW = new Date('2026-10-13T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const at = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString()

describe('dueSoonLabel', () => {
  test('labels an open item due within the next day, hours rounded up', () => {
    expect(dueSoonLabel(at(15 * HOUR), { now: NOW })).toBe('Due in 15h')
    expect(dueSoonLabel(at(15 * HOUR + 60_000), { now: NOW })).toBe('Due in 16h')
    expect(dueSoonLabel(at(23.5 * HOUR), { now: NOW })).toBe('Due in 24h')
    expect(dueSoonLabel(at(24 * HOUR), { now: NOW })).toBe('Due in 24h')
  })

  test('never says less than 1h', () => {
    expect(dueSoonLabel(at(60_000), { now: NOW })).toBe('Due in 1h')
    expect(dueSoonLabel(at(1), { now: NOW })).toBe('Due in 1h')
    expect(dueSoonLabel(at(HOUR), { now: NOW })).toBe('Due in 1h')
  })

  test('gives an overdue item, or one due right now, no label', () => {
    expect(dueSoonLabel(at(0), { now: NOW })).toBeNull()
    expect(dueSoonLabel(at(-60_000), { now: NOW })).toBeNull()
    expect(dueSoonLabel(at(-5 * HOUR), { now: NOW })).toBeNull()
  })

  test('gives an item due later than a day from now no label', () => {
    expect(dueSoonLabel(at(24 * HOUR + 1), { now: NOW })).toBeNull()
    expect(dueSoonLabel(at(3 * 24 * HOUR), { now: NOW })).toBeNull()
  })

  test('gives a completed item no label', () => {
    expect(dueSoonLabel(at(2 * HOUR), { now: NOW, completed: true })).toBeNull()
    expect(dueSoonLabel(at(2 * HOUR), { now: NOW, completed: false })).toBe('Due in 2h')
  })

  test('takes a Date, an ISO string or epoch ms, for the due time and for now', () => {
    const due = new Date(NOW.getTime() + 3 * HOUR)
    expect(dueSoonLabel(due, { now: NOW })).toBe('Due in 3h')
    expect(dueSoonLabel(due.getTime(), { now: NOW.getTime() })).toBe('Due in 3h')
    expect(dueSoonLabel(due.toISOString(), { now: NOW.toISOString() })).toBe('Due in 3h')
  })

  test('returns null without a readable due time', () => {
    expect(dueSoonLabel(null, { now: NOW })).toBeNull()
    expect(dueSoonLabel(undefined, { now: NOW })).toBeNull()
    expect(dueSoonLabel('', { now: NOW })).toBeNull()
    expect(dueSoonLabel('not a date', { now: NOW })).toBeNull()
  })

  test('uses the current time when no now is given', () => {
    expect(dueSoonLabel(new Date(Date.now() + 2 * HOUR - 1000))).toBe('Due in 2h')
    expect(dueSoonLabel(new Date(Date.now() - HOUR))).toBeNull()
  })
})
