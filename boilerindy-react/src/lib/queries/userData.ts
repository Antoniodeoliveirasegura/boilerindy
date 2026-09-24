import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import { authRequest } from '../authApi'
import { isServerRefusal } from '../writeFailure'

// The signed-in reads that several pages repeat, through the query cache
// (issue #327): the calendar window, the class list, the calendar categories
// and the task metadata. Every key carries the user id, so two accounts on one
// browser never see each other's rows, and nothing under ['me', ...] is ever
// written to storage (queryClient.ts excludes it; AuthContext clears the
// client on sign-out). The fetcher is authRequest, so a 401 still sends the
// browser to sign in. docs/client-cache.md has the map.

export type CalendarParams = { categories?: string; limit?: number; from?: string }

/** The window the Events and Free Food pages both read: one entry for the two of them. */
export const CAMPUS_EVENTS_CALENDAR: CalendarParams = { categories: 'campus_event,event,deadline', limit: 500 }
export type ClassesParams = { limit?: number; mode?: string }

export type Completion = { calendar_item_id?: string; completed_at?: string }
export type ManualTaskRow = {
  id: string
  title?: string
  startTime?: string | null
  completedAt?: string | null
  [key: string]: unknown
}
export type TaskMeta = {
  completions: Completion[]
  manualTasks: ManualTaskRow[]
  /** The server has no task tables yet (a 503 in disguise): the page falls back to the device store. */
  unavailable?: boolean
  local?: boolean
}
/** One completion toggle: the item, whether it is a manual task, and the state it should have next. */
export type ToggleInput = { id: string; isManual: boolean; completed: boolean }

/**
 * Midnight at the start of the local day `daysAgo` days back, as an ISO
 * instant. A "now minus 14 days" computed at call time is a new value on
 * every mount, which would give every mount its own cache entry; rounding to
 * the day keeps the key stable until the next local midnight.
 */
export function startOfLocalDayIso(daysAgo = 0, now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).toISOString()
}

function normalizeCalendarParams(params: CalendarParams) {
  return { categories: params.categories ?? '', limit: params.limit ?? 0, from: params.from ?? '' }
}

function normalizeClassesParams(params: ClassesParams) {
  return { limit: params.limit ?? 0, mode: params.mode ?? '' }
}

export function calendarUrl(params: CalendarParams): string {
  const search = new URLSearchParams()
  if (params.categories) search.set('categories', params.categories)
  if (params.limit) search.set('limit', String(params.limit))
  if (params.from) search.set('from', params.from)
  const query = search.toString()
  return `/api/me/calendar${query ? `?${query}` : ''}`
}

export function classesUrl(params: ClassesParams): string {
  const search = new URLSearchParams()
  if (params.limit) search.set('limit', String(params.limit))
  if (params.mode) search.set('mode', params.mode)
  const query = search.toString()
  return `/api/me/classes${query ? `?${query}` : ''}`
}

/** Every per-user key starts with ['me', userId], which is what keeps it out of storage and lets sign-out drop it. */
export const userKeys = {
  root: (userId: string) => ['me', userId] as const,
  calendar: (userId: string, params: CalendarParams) => ['me', userId, 'calendar', normalizeCalendarParams(params)] as const,
  classes: (userId: string, params: ClassesParams) => ['me', userId, 'classes', normalizeClassesParams(params)] as const,
  calendarCategories: (userId: string) => ['me', userId, 'calendar-categories'] as const,
  taskMeta: (userId: string) => ['me', userId, 'tasks', 'meta'] as const,
}

export function myCalendarQuery<T>(userId: string | null, params: CalendarParams) {
  return queryOptions({
    queryKey: userKeys.calendar(userId ?? '', params),
    queryFn: ({ signal }) => authRequest(calendarUrl(params), { signal }) as Promise<{ items?: T[] }>,
    enabled: Boolean(userId),
  })
}

export function myClassesQuery<T, M = { totalInTerm?: number; selectedTermLabel?: string }>(
  userId: string | null,
  params: ClassesParams,
) {
  return queryOptions({
    queryKey: userKeys.classes(userId ?? '', params),
    queryFn: ({ signal }) => authRequest(classesUrl(params), { signal }) as Promise<{ items?: T[]; meta?: M }>,
    enabled: Boolean(userId),
  })
}

export function myCalendarCategoriesQuery<T>(userId: string | null) {
  return queryOptions({
    queryKey: userKeys.calendarCategories(userId ?? ''),
    queryFn: ({ signal }) => authRequest('/api/me/calendar/categories', { signal }) as Promise<{ categories?: T[] }>,
    enabled: Boolean(userId),
  })
}

/**
 * GET /api/me/tasks/meta, normalized to the shape the Tasks page works with.
 * The arrays are copied so the cached snapshot owns its rows: TanStack keeps
 * the old object when a refetch is deep-equal to it, so a caller that mutated
 * the arrays it was handed could otherwise hide a change from every observer.
 */
export async function fetchTaskMeta(signal?: AbortSignal): Promise<TaskMeta> {
  const meta = (await authRequest('/api/me/tasks/meta', { signal })) as Partial<TaskMeta> | null
  return {
    completions: Array.isArray(meta?.completions) ? meta.completions.map((c) => ({ ...c })) : [],
    manualTasks: Array.isArray(meta?.manualTasks) ? meta.manualTasks.map((t) => ({ ...t })) : [],
    unavailable: meta?.unavailable === true,
    local: false,
  }
}

export function taskMetaQuery(userId: string | null) {
  return queryOptions({
    queryKey: userKeys.taskMeta(userId ?? ''),
    queryFn: ({ signal }) => fetchTaskMeta(signal),
    enabled: Boolean(userId),
    // No retries: the Tasks page has its own fallback (the device store) and
    // showed it after one failed read before the cache; three retries would
    // hold the whole page on a spinner for seven seconds first.
    retry: false,
  })
}

/** Mark every per-user row stale after a write that changes them elsewhere (a feed link, a sync, a source deletion). */
export function invalidateUserQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['me'] })
}

/**
 * Forget every per-user row (sign-out, a session that ended elsewhere) and
 * abort their fetches, leaving the public entries and the persisted snapshot
 * they feed alone.
 */
export function dropUserQueries(queryClient: QueryClient): void {
  void queryClient.cancelQueries({ queryKey: ['me'] })
  queryClient.removeQueries({ queryKey: ['me'] })
}

/** The signed-in user's id from the auth context, or null while signed out. */
export function useUserId(): string | null {
  const { user } = useAuth()
  return (user?.id as string | undefined) ?? null
}

export function useMyCalendar<T = Record<string, unknown>>(params: CalendarParams) {
  return useQuery(myCalendarQuery<T>(useUserId(), params))
}

export function useMyClasses<T = Record<string, unknown>, M = { totalInTerm?: number; selectedTermLabel?: string }>(
  params: ClassesParams,
) {
  return useQuery(myClassesQuery<T, M>(useUserId(), params))
}

export function useMyCalendarCategories<T = { id: string; label?: string; count?: number }>() {
  return useQuery(myCalendarCategoriesQuery<T>(useUserId()))
}

export function useTaskMeta() {
  return useQuery(taskMetaQuery(useUserId()))
}

/** The task metadata with one toggle applied, the way the server will store it. */
export function applyToggleToMeta(meta: TaskMeta, input: ToggleInput, now: string = new Date().toISOString()): TaskMeta {
  if (input.isManual) {
    return {
      ...meta,
      manualTasks: (meta.manualTasks || []).map((t) => (t.id === input.id ? { ...t, completedAt: input.completed ? now : null } : t)),
    }
  }
  const completions = (meta.completions || []).filter((c) => c.calendar_item_id !== input.id)
  if (input.completed) completions.push({ calendar_item_id: input.id, completed_at: now })
  return { ...meta, completions }
}

/**
 * Optimistic task completion. The tick lands in the cached metadata at once
 * (onMutate, after cancelling any metadata fetch in flight so it cannot land
 * on top), then the server call runs. A refusal (the user-write limiter's
 * 429, a 404 for an item a sync removed) restores the snapshot; the page
 * shows why. No response or a 5xx keeps the tick, and the page mirrors it to
 * the device store, today's "saved on this device" fallback. Either way the
 * metadata is invalidated afterwards, so the cache ends on the server's truth.
 */
export function useToggleTaskCompletion(userId: string | null) {
  const queryClient = useQueryClient()
  const queryKey = userKeys.taskMeta(userId ?? '')
  return useMutation({
    mutationFn: async (input: ToggleInput) => {
      if (input.isManual) {
        await authRequest(`/api/me/tasks/manual/${input.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ completed: input.completed }),
        })
      } else {
        await authRequest('/api/me/tasks/calendar/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarItemId: input.id, completed: input.completed }),
        })
      }
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<TaskMeta>(queryKey)
      if (previous) queryClient.setQueryData<TaskMeta>(queryKey, applyToggleToMeta(previous, input))
      return { previous }
    },
    onError: (error, input, context) => {
      // Undo this toggle alone, on whatever the cache holds now, so a second
      // tick that landed while this one was in flight keeps its own patch;
      // restoring the snapshot would wipe it until its own refetch.
      if (!isServerRefusal(error) || !context?.previous) return
      queryClient.setQueryData<TaskMeta>(queryKey, (current) =>
        current ? applyToggleToMeta(current, { ...input, completed: !input.completed }) : current,
      )
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
}
