import { beforeEach, describe, expect, test } from 'vitest'
import { loadLocalTasks, saveLocalTasks, taskMetaFromLocalStore } from './taskLocalStore'

// Issue #225 - the device-only task store (used while the API has no task
// tables) is keyed per backend user id, tolerates whatever is in localStorage,
// and hands the Tasks page the same shape as GET /api/me/tasks/meta.

const EMPTY = { completions: {}, manualTasks: [] }
const state = {
  completions: { 'cal-1': '2026-09-20T12:00:00.000Z' },
  manualTasks: [
    { id: 'm1', title: 'Buy a lab notebook', startTime: '2026-09-25T04:00:00.000Z', completedAt: null },
    { id: 'm2', title: 'Email the TA' },
  ],
}

beforeEach(() => localStorage.clear())

describe('loadLocalTasks and saveLocalTasks', () => {
  test('round-trips per user under the boilerindy-tasks-v1 key', () => {
    saveLocalTasks('user-1', state)
    expect(Object.keys(localStorage)).toEqual(['boilerindy-tasks-v1-user-1'])
    expect(loadLocalTasks('user-1')).toEqual(state)
  })

  test('another user reads an empty state', () => {
    saveLocalTasks('user-1', state)
    expect(loadLocalTasks('user-2')).toEqual(EMPTY)
  })

  test('no user id means no read and no write', () => {
    saveLocalTasks(null, state)
    saveLocalTasks(undefined, state)
    saveLocalTasks('', state)
    expect(localStorage.length).toBe(0)
    expect(loadLocalTasks(null)).toEqual(EMPTY)
    expect(loadLocalTasks(undefined)).toEqual(EMPTY)
  })

  test('corrupt or mis-shaped storage falls back to the empty state field by field', () => {
    localStorage.setItem('boilerindy-tasks-v1-user-1', '{not json')
    expect(loadLocalTasks('user-1')).toEqual(EMPTY)

    localStorage.setItem('boilerindy-tasks-v1-user-1', JSON.stringify({ completions: 'nope', manualTasks: { id: 'x' } }))
    expect(loadLocalTasks('user-1')).toEqual(EMPTY)

    localStorage.setItem('boilerindy-tasks-v1-user-1', JSON.stringify({ completions: null, manualTasks: state.manualTasks }))
    expect(loadLocalTasks('user-1')).toEqual({ completions: {}, manualTasks: state.manualTasks })
  })

  test('saves only the two known fields', () => {
    saveLocalTasks('user-1', { ...state, extra: 'dropped' } as typeof state)
    expect(JSON.parse(localStorage.getItem('boilerindy-tasks-v1-user-1')!)).toEqual(state)
  })
})

describe('taskMetaFromLocalStore', () => {
  test('matches the GET /api/me/tasks/meta shape and flags the data as device-only', () => {
    saveLocalTasks('user-1', state)
    const meta = taskMetaFromLocalStore('user-1')
    expect(meta.unavailable).toBe(true)
    expect(meta.local).toBe(true)
    expect(meta.completions).toEqual([{ calendar_item_id: 'cal-1', completed_at: '2026-09-20T12:00:00.000Z' }])
    expect(meta.manualTasks).toEqual([
      {
        id: 'm1',
        title: 'Buy a lab notebook',
        startTime: '2026-09-25T04:00:00.000Z',
        endTime: null,
        category: 'manual_task',
        sourceType: 'manual',
        description: null,
        location: null,
        externalUid: null,
        sourceId: null,
        completedAt: null,
        isManual: true,
      },
      expect.objectContaining({ id: 'm2', title: 'Email the TA', startTime: undefined, completedAt: null, isManual: true }),
    ])
  })

  test('is empty but well-formed without a user or without data', () => {
    for (const meta of [taskMetaFromLocalStore(null), taskMetaFromLocalStore('user-9')]) {
      expect(meta).toEqual({ completions: [], manualTasks: [], unavailable: true, local: true })
    }
  })
})
