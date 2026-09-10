import { beforeEach, describe, expect, test } from 'vitest'
import {
  addManualClass,
  applyScheduleOverridesToItems,
  classSeriesKey,
  hideSeries,
  isoToHm,
  loadScheduleOverrides,
  manualClassesAsItems,
  removeManualClass,
  saveSeriesOverride,
  updateManualClass,
} from './scheduleOverrideStore'

// PR #179 - schedule corrections that survive an ICS re-sync, kept per user in
// localStorage. Dates below are fixed weekdays: 2026-09-07 is a Monday.
const MON = '2026-09-07T14:30:00.000Z'
const SAT = '2026-09-12T14:30:00.000Z'

function classItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cal-1',
    title: 'CS 18000',
    description: 'Problem Solving',
    location: 'LWSN B155',
    startTime: MON,
    endTime: '2026-09-07T15:20:00.000Z',
    ...overrides,
  }
}

beforeEach(() => localStorage.clear())

describe('loadScheduleOverrides', () => {
  test('returns an empty state for an anonymous user', () => {
    expect(loadScheduleOverrides(null)).toEqual({ series: {}, manual: [] })
  })

  test('keeps overrides per user id', () => {
    saveSeriesOverride('user-1', 'k', { room: 'HAAS 111' })
    expect(loadScheduleOverrides('user-2')).toEqual({ series: {}, manual: [] })
    expect(loadScheduleOverrides('user-1').series.k).toEqual({ room: 'HAAS 111' })
  })

  test('survives corrupt storage', () => {
    localStorage.setItem('boilerindy-schedule-overrides-v1-user-1', '{not json')
    expect(loadScheduleOverrides('user-1')).toEqual({ series: {}, manual: [] })
  })

  test('drops malformed rows instead of throwing', () => {
    localStorage.setItem(
      'boilerindy-schedule-overrides-v1-user-1',
      JSON.stringify({ series: { k: { startHm: 'noon' } }, manual: [{ id: 'm' }] }),
    )
    expect(loadScheduleOverrides('user-1')).toEqual({ series: {}, manual: [] })
  })

  test('normalizes single-digit hours', () => {
    localStorage.setItem(
      'boilerindy-schedule-overrides-v1-user-1',
      JSON.stringify({ series: { k: { startHm: '9:05' } }, manual: [] }),
    )
    expect(loadScheduleOverrides('user-1').series.k.startHm).toBe('09:05')
  })
})

describe('saveSeriesOverride', () => {
  test('clears the override when passed null', () => {
    saveSeriesOverride('user-1', 'k', { room: 'HAAS 111' })
    expect(saveSeriesOverride('user-1', 'k', null).series.k).toBeUndefined()
  })

  test('hide and restore round-trip', () => {
    expect(hideSeries('user-1', 'k').series.k).toEqual({ hidden: true })
    expect(hideSeries('user-1', 'k', false).series.k).toBeUndefined()
  })

  test('restoring keeps other edits on the same series', () => {
    saveSeriesOverride('user-1', 'k', { room: 'HAAS 111' })
    hideSeries('user-1', 'k')
    expect(hideSeries('user-1', 'k', false).series.k).toEqual({ room: 'HAAS 111' })
  })
})

describe('manual classes', () => {
  test('add, update and remove', () => {
    const added = addManualClass('user-1', {
      code: ' CS 25100 ',
      name: '',
      room: '',
      days: ['Tuesday'],
      startHm: '9:00',
      endHm: '10:15',
    })
    expect(added.manual).toHaveLength(1)
    expect(added.manual[0].code).toBe('CS 25100')
    expect(added.manual[0].name).toBe('Class meeting')
    expect(added.manual[0].startHm).toBe('09:00')

    const id = added.manual[0].id
    expect(updateManualClass('user-1', id, { room: 'LWSN 3102' }).manual[0].room).toBe('LWSN 3102')
    expect(removeManualClass('user-1', id).manual).toEqual([])
  })

  test('only surface on the days they meet', () => {
    const state = addManualClass('user-1', {
      code: 'CS 25100',
      name: 'Data Structures',
      room: '',
      days: ['Monday'],
      startHm: '09:00',
      endHm: '10:15',
    })
    expect(manualClassesAsItems(state.manual, new Date(MON))).toHaveLength(1)
    expect(manualClassesAsItems(state.manual, new Date(SAT))).toHaveLength(0)
  })
})

describe('applyScheduleOverridesToItems', () => {
  test('drops a hidden series', () => {
    const state = hideSeries('user-1', classSeriesKey(classItem()))
    expect(applyScheduleOverridesToItems([classItem()], state)).toEqual([])
  })

  test('applies field and time edits without mutating the source', () => {
    const item = classItem()
    const state = saveSeriesOverride('user-1', classSeriesKey(item), {
      code: 'CS 180',
      room: 'HAAS 111',
      startHm: '11:00',
    })
    const [out] = applyScheduleOverridesToItems([item], state)
    expect(out.title).toBe('CS 180')
    expect(out.location).toBe('HAAS 111')
    expect(new Date(out.startTime as string).getHours()).toBe(11)
    expect(item.title).toBe('CS 18000')
  })

  test('a day list hides the unchecked weekdays', () => {
    const item = classItem()
    const state = saveSeriesOverride('user-1', classSeriesKey(item), { days: ['Wednesday'] })
    expect(applyScheduleOverridesToItems([item], state)).toEqual([])
  })

  test('a day list never drops a weekend meeting the editor cannot show', () => {
    // The editor only offers Mon-Fri, so a Saturday lab must survive an edit
    // that only narrowed the weekdays.
    const saturday = classItem({ startTime: SAT, endTime: null })
    const state = saveSeriesOverride('user-1', classSeriesKey(saturday), {
      days: ['Monday', 'Wednesday'],
    })
    expect(applyScheduleOverridesToItems([saturday], state)).toHaveLength(1)
  })
})

describe('isoToHm', () => {
  test('falls back to 09:00 for missing or invalid input', () => {
    expect(isoToHm(null)).toBe('09:00')
    expect(isoToHm('not-a-date')).toBe('09:00')
  })
})
