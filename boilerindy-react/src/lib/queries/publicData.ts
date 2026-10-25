import { infiniteQueryOptions, keepPreviousData, queryOptions, useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query'
import { QUERY_CACHE_MAX_AGE_MS } from '../queryClient'
import { buildClubsQuery, CLUBS_PAGE_SIZE, type ClubSearchParams, type ClubSearchResult } from '../clubs'
import type { CampusEventFields } from '../campusEvents'
import type { CampusNews } from '../campusNews'
import type { DiningSnapshot, DiningUpcoming, DishDetail } from '../dining'
import type { ParkingSnapshot } from '../parking'

// The public reads through the query cache (issue #251). Keys, stale
// times and polling live here so Home, Transit, Dining, Parking, the map's
// garage layer and Clubs share one entry per dataset; docs/client-cache.md
// explains the numbers. Every fetch goes through fetchJson so a 429 carries
// the limiter's Retry-After into the retry delay.

/** A failed request: the HTTP status and, on a 429, how long the limiter asked us to wait. */
export class ApiError extends Error {
  status: number
  retryAfterMs?: number

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** Retry-After as milliseconds: delta seconds or an HTTP date, undefined when absent or unreadable. */
export function retryAfterMsFromHeader(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

function messageFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const { error, message } = body as { error?: unknown; message?: unknown }
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  if (typeof message === 'string' && message) return message
  return null
}

/** fetch + JSON, throwing an ApiError (with the server's message when it sent one) for any non-2xx answer. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      message = messageFromBody(await response.json()) ?? message
    } catch {
      // A non-JSON error body keeps the generic message.
    }
    const retryAfterMs = response.status === 429 ? retryAfterMsFromHeader(response.headers.get('Retry-After')) : undefined
    throw new ApiError(message, response.status, retryAfterMs)
  }
  return (await response.json()) as T
}

/** The message to show for a failed query, or the fallback when the error carries none. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** Stale times: how long a cached answer is served without a background refetch. */
export const TRANSIT_STATIC_STALE_MS = 10 * 60_000
export const TRANSIT_VEHICLES_STALE_MS = 10_000
export const TRANSIT_VEHICLES_POLL_MS = 10_000
export const DINING_STALE_MS = 5 * 60_000
export const PARKING_STALE_MS = 60_000
/** The parking page and the map's garage layer refresh on this interval while the tab is visible. */
export const PARKING_REFRESH_MS = 60_000
export const CLUBS_STALE_MS = 30 * 60_000

// Public entries stay in memory (and so in storage) for as long as the
// persisted cache is trusted, instead of TanStack's five-minute default: the
// whole point is that a dashboard opened tomorrow still paints from them.
const PUBLIC_GC_TIME_MS = QUERY_CACHE_MAX_AGE_MS

export const transitRoutesQuery = queryOptions({
  queryKey: ['transit', 'routes'] as const,
  queryFn: ({ signal }) => fetchJson<unknown[]>('/api/transit/routes', { signal }),
  staleTime: TRANSIT_STATIC_STALE_MS,
  gcTime: PUBLIC_GC_TIME_MS,
})

export const transitStopsQuery = queryOptions({
  queryKey: ['transit', 'stops'] as const,
  queryFn: ({ signal }) => fetchJson<unknown[]>('/api/transit/stops', { signal }),
  staleTime: TRANSIT_STATIC_STALE_MS,
  gcTime: PUBLIC_GC_TIME_MS,
})

// Live positions: polled every 10 s while a Transit screen or the dashboard is
// open and the tab is visible. refetchIntervalInBackground is false, so a
// hidden tab stops the poll and spends neither battery nor the
// transit-vehicles budget; TanStack resumes it when the tab shows again.
export const transitVehiclesQuery = queryOptions({
  queryKey: ['transit', 'vehicles'] as const,
  queryFn: ({ signal }) => fetchJson<unknown[]>('/api/transit/vehicles', { signal }),
  staleTime: TRANSIT_VEHICLES_STALE_MS,
  refetchInterval: TRANSIT_VEHICLES_POLL_MS,
  refetchIntervalInBackground: false,
  gcTime: PUBLIC_GC_TIME_MS,
})

export const diningQuery = queryOptions({
  queryKey: ['dining'] as const,
  queryFn: ({ signal }) => fetchJson<DiningSnapshot>('/api/dining', { signal }),
  staleTime: DINING_STALE_MS,
  gcTime: PUBLIC_GC_TIME_MS,
})

// One dish's details (issue #468), fetched when the dish is opened. Kept in
// memory only (NEVER_PERSISTED in queryClient.ts): a visit opens a handful,
// and they would only pile up in storage.
export const DINING_FOOD_STALE_MS = 10 * 60_000

export function diningFoodQuery(id: number, date: string) {
  return queryOptions({
    queryKey: ['dining', 'food', id, date] as const,
    queryFn: ({ signal }) =>
      fetchJson<{ ok: true; date: string; food: DishDetail }>(`/api/dining/foods/${id}?date=${encodeURIComponent(date)}`, { signal }),
    staleTime: DINING_FOOD_STALE_MS,
    gcTime: PUBLIC_GC_TIME_MS,
  })
}

// What is coming up on the menus (issue #469): headliners about six weeks out
// and this week's specials. The server caches the digest for 12 h, so half an
// hour here is plenty fresh. Persisted like the snapshot.
export const DINING_UPCOMING_STALE_MS = 30 * 60_000

export const diningUpcomingQuery = queryOptions({
  queryKey: ['dining', 'upcoming'] as const,
  queryFn: ({ signal }) => fetchJson<DiningUpcoming>('/api/dining/upcoming', { signal }),
  staleTime: DINING_UPCOMING_STALE_MS,
  gcTime: PUBLIC_GC_TIME_MS,
})

// The Circuit's headlines (issue #470). The server refreshes the feed at most
// once an hour, so half an hour here is fresh enough. An answer without news
// (the feed was down) is stale at once, so the next visit asks again instead
// of keeping an empty widget for half an hour. Persisted like the other
// public reads.
export const CAMPUS_NEWS_STALE_MS = 30 * 60_000

export const campusNewsQuery = queryOptions({
  queryKey: ['news', 'circuit'] as const,
  queryFn: ({ signal }) => fetchJson<CampusNews>('/api/campus-news', { signal }),
  staleTime: (query) => (query.state.data?.ok === false ? 0 : CAMPUS_NEWS_STALE_MS),
  gcTime: PUBLIC_GC_TIME_MS,
})

// The free food on campus calendars for a signed-out visitor (issue #366):
// the shared campus events with free food, from the session-free
// GET /api/campus-events/free-food. A signed-in student's Free Food page reads
// the same rows in its own calendar window instead (CAMPUS_EVENTS_CALENDAR in
// userData.ts), beside their own events. The server reads the table at most
// once a minute, and the page drops a row once it is over.
export const FREE_FOOD_STALE_MS = 60_000

/** One row as the server sends it: toSharedCalendarItem in src/campusEventsFeed.mjs. */
export type PublicFreeFoodItem = CampusEventFields & {
  id: string
  title?: string
  description?: string | null
  location?: string | null
  category?: string
  freeFood?: boolean
}
export type PublicFreeFood = { ok?: boolean; items?: PublicFreeFoodItem[] }

export const freeFoodQuery = queryOptions({
  queryKey: ['events', 'free-food'] as const,
  queryFn: ({ signal }) => fetchJson<PublicFreeFood>('/api/campus-events/free-food', { signal }),
  staleTime: FREE_FOOD_STALE_MS,
  gcTime: PUBLIC_GC_TIME_MS,
})

export const parkingQuery = queryOptions({
  queryKey: ['parking'] as const,
  queryFn: ({ signal }) => fetchJson<ParkingSnapshot>('/api/parking/garages', { signal }),
  staleTime: PARKING_STALE_MS,
  refetchInterval: PARKING_REFRESH_MS,
  refetchIntervalInBackground: false,
  gcTime: PUBLIC_GC_TIME_MS,
})

export type ClubSearchFilters = {
  q: string
  category: string
  scope: 'indianapolis' | 'all'
  pageSize: number
}

/** One canonical shape per search, so two spellings of the same filters share a cache entry. */
export function normalizeClubFilters(params: Omit<ClubSearchParams, 'page'>): ClubSearchFilters {
  return {
    q: (params.q || '').trim(),
    category: (params.category || '').trim(),
    scope: params.scope === 'indianapolis' ? 'indianapolis' : 'all',
    pageSize: params.pageSize && params.pageSize > 0 ? Math.floor(params.pageSize) : CLUBS_PAGE_SIZE,
  }
}

/**
 * A club search is one entry per set of filters holding every page fetched so
 * far, so "Show more" appends to it and a filter the student comes back to
 * answers at once with all of its pages. New filters keep the previous list on
 * screen (dimmed) until the first page arrives, the way the page behaved
 * before the cache.
 */
export function clubSearchQuery(params: Omit<ClubSearchParams, 'page'>) {
  const filters = normalizeClubFilters(params)
  return infiniteQueryOptions({
    queryKey: ['clubs', filters] as const,
    queryFn: ({ pageParam, signal }) =>
      fetchJson<ClubSearchResult>(`/api/clubs${buildClubsQuery({ ...filters, page: pageParam })}`, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.ok && last.page < last.pages ? last.page + 1 : undefined),
    staleTime: CLUBS_STALE_MS,
    gcTime: PUBLIC_GC_TIME_MS,
    placeholderData: keepPreviousData,
  })
}

export const useTransitRoutes = () => useQuery(transitRoutesQuery)
export const useTransitStops = () => useQuery(transitStopsQuery)
export const useTransitVehicles = () => useQuery(transitVehiclesQuery)
export const useDining = () => useQuery(diningQuery)
export const useDiningUpcoming = ({ enabled = true }: { enabled?: boolean } = {}) => useQuery({ ...diningUpcomingQuery, enabled })
/** A dish's details; nothing is fetched until there is an id and a date. */
export const useDiningFood = (id: number | null | undefined, date: string | null | undefined) =>
  useQuery({ ...diningFoodQuery(id ?? 0, date ?? ''), enabled: id != null && Boolean(date) })
export const useCampusNews = () => useQuery(campusNewsQuery)
export const useParking = ({ enabled = true }: { enabled?: boolean } = {}) => useQuery({ ...parkingQuery, enabled })
/** The signed-out Free Food list; the page enables it only once auth has settled with no user. */
export const usePublicFreeFood = ({ enabled = true }: { enabled?: boolean } = {}) => useQuery({ ...freeFoodQuery, enabled })
export const useClubSearch = (params: Omit<ClubSearchParams, 'page'>) => useInfiniteQuery(clubSearchQuery(params))

/**
 * The Dining page's Refresh button: bypass every cache with ?refresh=1 (the
 * server refetches a date at most every ten minutes) and land the answer in
 * the shared entry so Home's widget sees it too. The fetch runs through the
 * query itself, after cancelling any refetch already in flight, so an older
 * answer that was mid-air cannot overwrite the fresh one a moment later.
 */
export async function refreshDining(queryClient: QueryClient): Promise<DiningSnapshot> {
  await queryClient.cancelQueries({ queryKey: diningQuery.queryKey })
  // fetchQuery leaves this forced queryFn and staleTime on the entry until a
  // page observes it again (the hook's options replace them then). Nothing
  // invalidates or refetches ['dining'] on its own today; anything that
  // starts to should refetch through the hook rather than the entry.
  return queryClient.fetchQuery({
    ...diningQuery,
    queryFn: ({ signal }) => fetchJson<DiningSnapshot>('/api/dining?refresh=1', { signal }),
    staleTime: 0,
  })
}
