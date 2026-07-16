import { beforeEach, describe, expect, test } from 'vitest'
import { loadPriorities, savePriority, PRIORITY_LEVELS } from './taskPriorityStore'

// Issue #6 - assignment priority labels persist per user in localStorage.
beforeEach(() => localStorage.clear())

describe('taskPriorityStore', () => {
  test('returns an empty map when nothing is saved', () => {
    expect(loadPriorities('user-1')).toEqual({})
  })

  test('saves and loads a priority for an item', () => {
    savePriority('user-1', 'task-a', 'high')
    expect(loadPriorities('user-1')).toEqual({ 'task-a': 'high' })
  })

  test('returns a new map without mutating the previous one', () => {
    const first = savePriority('user-1', 'task-a', 'high')
    const second = savePriority('user-1', 'task-b', 'low')
    expect(second).not.toBe(first)
    expect(second).toEqual({ 'task-a': 'high', 'task-b': 'low' })
  })

  test('clears a priority when passed null', () => {
    savePriority('user-1', 'task-a', 'high')
    savePriority('user-1', 'task-a', null)
    expect(loadPriorities('user-1')).toEqual({})
  })

  test('ignores invalid priority levels', () => {
    // @ts-expect-error 'urgent' is not a valid Priority; the runtime guard must drop it
    savePriority('user-1', 'task-a', 'urgent')
    expect(loadPriorities('user-1')).toEqual({})
  })

  test('is scoped per user', () => {
    savePriority('user-1', 'task-a', 'high')
    expect(loadPriorities('user-2')).toEqual({})
  })

  test('exposes the three supported levels', () => {
    expect(PRIORITY_LEVELS).toEqual(['high', 'medium', 'low'])
  })
})
