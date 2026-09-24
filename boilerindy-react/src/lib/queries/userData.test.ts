import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { authRequest } from '../authApi'
import { isPersistedQueryKey, shouldDehydrateQuery } from '../queryClient'
import {
  applyToggleToMeta,
  calendarUrl,
  classesUrl,
  dropUserQueries,
  fetchTaskMeta,
  invalidateUserQueries,
  startOfLocalDayIso,
  taskMetaQuery,
  useToggleTaskCompletion,
  userKeys,
  type TaskMeta,
} from './userData'

// Issue #327 - per-user reads through the query cache: keys carry the user id
// and the parameters, the calendar window's lower bound is rounded to the
// day, nothing under ['me', ...] reaches storage, and a task tick is
// optimistic with a rollback on a refusal only.

vi.mock('../authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' }, loading: false }) }))

const request = vi.mocked(authRequest)

function httpError(status: number, message?: string) {
  return Object.assign(new Error(message || `HTTP ${status}`), { status, payload: message ? { error: { message, status } } : {} })
}

beforeEach(() => {
  request.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('keys and urls', () => {
  test('every key starts with the user id and carries the normalized parameters', () => {
    expect(userKeys.calendar('u1', { categories: 'event', limit: 500 })).toEqual(['me', 'u1', 'calendar', { categories: 'event', limit: 500, from: '' }])
    expect(userKeys.calendar('u1', { limit: 500 })).toEqual(userKeys.calendar('u1', { limit: 500, categories: undefined }))
    expect(userKeys.calendar('u1', { limit: 500 })).not.toEqual(userKeys.calendar('u2', { limit: 500 }))
    expect(userKeys.classes('u1', { limit: 200, mode: 'display' })).toEqual(['me', 'u1', 'classes', { limit: 200, mode: 'display' }])
    expect(userKeys.calendarCategories('u1')).toEqual(['me', 'u1', 'calendar-categories'])
    expect(userKeys.taskMeta('u1')).toEqual(['me', 'u1', 'tasks', 'meta'])
  })

  test('the urls match what the pages sent before', () => {
    expect(calendarUrl({ categories: 'campus_event,event,deadline', limit: 500 })).toBe('/api/me/calendar?categories=campus_event%2Cevent%2Cdeadline&limit=500')
    expect(calendarUrl({ limit: 500, from: '2026-09-10T04:00:00.000Z' })).toBe('/api/me/calendar?limit=500&from=2026-09-10T04%3A00%3A00.000Z')
    expect(calendarUrl({})).toBe('/api/me/calendar')
    expect(classesUrl({ limit: 200, mode: 'display' })).toBe('/api/me/classes?limit=200&mode=display')
  })

  test('the calendar window lower bound is rounded to local midnight so the key is stable within a day', () => {
    const noon = new Date(2026, 8, 24, 12, 34, 56)
    const later = new Date(2026, 8, 24, 23, 59, 59)
    expect(startOfLocalDayIso(14, noon)).toBe(startOfLocalDayIso(14, later))
    expect(new Date(startOfLocalDayIso(14, noon)).getTime()).toBe(new Date(2026, 8, 10).getTime())
    expect(new Date(startOfLocalDayIso(0, noon)).getTime()).toBe(new Date(2026, 8, 24).getTime())
  })

  test('dropUserQueries forgets the me rows and leaves the public ones alone', () => {
    const client = new QueryClient()
    client.setQueryData(userKeys.taskMeta('u1'), { completions: [], manualTasks: [] })
    client.setQueryData(userKeys.calendar('u1', { limit: 500 }), { items: [] })
    client.setQueryData(['dining'], { ok: true, locations: [] })
    dropUserQueries(client)
    expect(client.getQueryData(userKeys.taskMeta('u1'))).toBeUndefined()
    expect(client.getQueryData(userKeys.calendar('u1', { limit: 500 }))).toBeUndefined()
    expect(client.getQueryData(['dining'])).toEqual({ ok: true, locations: [] })
  })

  test('invalidateUserQueries marks the me rows stale', async () => {
    const client = new QueryClient()
    client.setQueryData(userKeys.taskMeta('u1'), { completions: [], manualTasks: [] })
    client.setQueryData(['dining'], { ok: true })
    await invalidateUserQueries(client)
    expect(client.getQueryState(userKeys.taskMeta('u1'))?.isInvalidated).toBe(true)
    expect(client.getQueryState(['dining'])?.isInvalidated).toBe(false)
  })

  test('nothing under me is persisted', () => {
    expect(isPersistedQueryKey(userKeys.taskMeta('u1'))).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: userKeys.calendar('u1', { limit: 500 }), state: { status: 'success' } } as never)).toBe(false)
  })
})

describe('fetchTaskMeta', () => {
  test('normalizes the answer and keeps the unavailable flag', async () => {
    request.mockResolvedValueOnce({ completions: [{ calendar_item_id: 'a', completed_at: 'x' }], manualTasks: 'nope' })
    await expect(fetchTaskMeta()).resolves.toEqual({
      completions: [{ calendar_item_id: 'a', completed_at: 'x' }],
      manualTasks: [],
      unavailable: false,
      local: false,
    })
    request.mockResolvedValueOnce({ completions: [], manualTasks: [], unavailable: true })
    await expect(fetchTaskMeta()).resolves.toMatchObject({ unavailable: true, local: false })
  })
})

describe('applyToggleToMeta', () => {
  const meta: TaskMeta = {
    completions: [{ calendar_item_id: 'cal-1', completed_at: '2026-09-20T00:00:00.000Z' }],
    manualTasks: [{ id: 'm1', title: 'Lab', completedAt: null }],
  }

  test('adds and removes a calendar completion', () => {
    const done = applyToggleToMeta(meta, { id: 'cal-2', isManual: false, completed: true }, 'now')
    expect(done.completions).toEqual([...meta.completions, { calendar_item_id: 'cal-2', completed_at: 'now' }])
    const undone = applyToggleToMeta(meta, { id: 'cal-1', isManual: false, completed: false })
    expect(undone.completions).toEqual([])
    expect(meta.completions).toHaveLength(1)
  })

  test('sets and clears completedAt on a manual task', () => {
    expect(applyToggleToMeta(meta, { id: 'm1', isManual: true, completed: true }, 'now').manualTasks[0].completedAt).toBe('now')
    expect(applyToggleToMeta(meta, { id: 'm1', isManual: true, completed: false }).manualTasks[0].completedAt).toBeNull()
  })
})

describe('useToggleTaskCompletion', () => {
  const key = userKeys.taskMeta('u1')
  const serverMeta: TaskMeta = { completions: [], manualTasks: [{ id: 'm1', title: 'Lab', completedAt: null }], unavailable: false, local: false }

  // The page observes the metadata query, which is what makes the invalidation
  // after a toggle refetch it; staleTime Infinity keeps the mount itself from
  // fetching, so the seeded snapshot is what the mutation starts from.
  function setup() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    })
    client.setQueryData(key, serverMeta)
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result: observed } = renderHook(
      () => {
        useQuery(taskMetaQuery('u1'))
        return useToggleTaskCompletion('u1')
      },
      { wrapper },
    )
    return { client, result: observed }
  }

  test('the tick lands before the server answers, then the metadata is refetched', async () => {
    const { client, result } = setup()
    let resolveWrite: (v: unknown) => void = () => {}
    request.mockImplementation((_url, options) => {
      if (options?.method === 'POST') return new Promise((resolve) => (resolveWrite = resolve))
      return Promise.resolve({ completions: [{ calendar_item_id: 'cal-1', completed_at: 'server' }], manualTasks: serverMeta.manualTasks })
    })
    const pending = result.current.mutateAsync({ id: 'cal-1', isManual: false, completed: true })
    await waitFor(() => expect(client.getQueryData<TaskMeta>(key)?.completions).toHaveLength(1))
    expect(request).toHaveBeenCalledWith(
      '/api/me/tasks/calendar/complete',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ calendarItemId: 'cal-1', completed: true }) }),
    )
    resolveWrite({ ok: true })
    await pending
    await waitFor(() => expect(client.getQueryData<TaskMeta>(key)?.completions[0].completed_at).toBe('server'))
  })

  test('a refusal rolls the tick back and rejects with the error', async () => {
    const { client, result } = setup()
    request.mockImplementation((_url, options) => {
      if (options?.method) return Promise.reject(httpError(429, 'You are making changes too quickly. Please wait a moment and try again.'))
      return Promise.resolve(serverMeta)
    })
    await expect(result.current.mutateAsync({ id: 'm1', isManual: true, completed: true })).rejects.toMatchObject({ status: 429 })
    await waitFor(() => expect(client.getQueryData<TaskMeta>(key)).toEqual(serverMeta))
    expect(request).toHaveBeenCalledWith('/api/me/tasks/manual/m1', expect.objectContaining({ method: 'PATCH' }))
  })

  test('a refusal undoes only its own toggle, so a second tick in flight keeps its patch', async () => {
    const { client, result } = setup()
    let rejectFirst: (e: unknown) => void = () => {}
    request.mockImplementation((_url, options) => {
      if (options?.method === 'PATCH') return new Promise((_resolve, reject) => (rejectFirst = reject))
      if (options?.method === 'POST') return Promise.resolve({ ok: true })
      return Promise.resolve({ ...serverMeta, completions: [{ calendar_item_id: 'cal-1', completed_at: 'server' }] })
    })
    const first = result.current.mutateAsync({ id: 'm1', isManual: true, completed: true }).catch((e: unknown) => e)
    await waitFor(() => expect(client.getQueryData<TaskMeta>(key)?.manualTasks[0].completedAt).not.toBeNull())
    await result.current.mutateAsync({ id: 'cal-1', isManual: false, completed: true })
    rejectFirst(httpError(429))
    await first
    const after = client.getQueryData<TaskMeta>(key)
    expect(after?.manualTasks[0].completedAt).toBeNull()
    expect(after?.completions.map((c) => c.calendar_item_id)).toEqual(['cal-1'])
  })

  test('no response keeps the tick for the device-store fallback', async () => {
    const { client, result } = setup()
    request.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(result.current.mutateAsync({ id: 'm1', isManual: true, completed: true })).rejects.toBeInstanceOf(TypeError)
    expect(client.getQueryData<TaskMeta>(key)?.manualTasks[0].completedAt).not.toBeNull()
  })
})
