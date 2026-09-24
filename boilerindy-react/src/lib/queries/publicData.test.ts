import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, dehydrate, hydrate } from '@tanstack/react-query'
import {
  ApiError,
  CLUBS_STALE_MS,
  DINING_STALE_MS,
  PARKING_REFRESH_MS,
  PARKING_STALE_MS,
  TRANSIT_STATIC_STALE_MS,
  TRANSIT_VEHICLES_POLL_MS,
  TRANSIT_VEHICLES_STALE_MS,
  clubSearchQuery,
  diningQuery,
  errorMessage,
  fetchJson,
  normalizeClubFilters,
  parkingQuery,
  refreshDining,
  retryAfterMsFromHeader,
  transitRoutesQuery,
  transitStopsQuery,
  transitVehiclesQuery,
} from './publicData'
import {
  BUILD_ID,
  MAX_RETRY_WAIT_MS,
  QUERY_CACHE_MAX_AGE_MS,
  createQueryClient,
  createQueryPersister,
  dehydrateOptions,
  hydrateOptions,
  isPersistedQueryKey,
  isPublicQueryKey,
  retryDelayMs,
  shouldDehydrateQuery,
  shouldRetry,
} from '../queryClient'

// Issue #251 - the client data cache. These pin the per-dataset defaults, the
// retry policy (a 429 waits what the limiter asked, a 404 never retries), what
// is allowed into localStorage, and the fetcher's error shape.

afterEach(() => {
  vi.restoreAllMocks()
})

describe('per-dataset defaults', () => {
  test('keys and stale times', () => {
    expect(transitRoutesQuery.queryKey).toEqual(['transit', 'routes'])
    expect(transitRoutesQuery.staleTime).toBe(TRANSIT_STATIC_STALE_MS)
    expect(transitStopsQuery.staleTime).toBe(TRANSIT_STATIC_STALE_MS)
    expect(TRANSIT_STATIC_STALE_MS).toBe(10 * 60_000)
    expect(transitVehiclesQuery.staleTime).toBe(TRANSIT_VEHICLES_STALE_MS)
    expect(TRANSIT_VEHICLES_STALE_MS).toBe(10_000)
    expect(diningQuery.queryKey).toEqual(['dining'])
    expect(diningQuery.staleTime).toBe(DINING_STALE_MS)
    expect(DINING_STALE_MS).toBe(5 * 60_000)
    expect(parkingQuery.staleTime).toBe(PARKING_STALE_MS)
    expect(PARKING_STALE_MS).toBe(60_000)
    expect(clubSearchQuery({}).staleTime).toBe(CLUBS_STALE_MS)
    expect(CLUBS_STALE_MS).toBe(30 * 60_000)
  })

  test('the vehicle poll runs every 10 s and pauses while the tab is hidden', () => {
    expect(transitVehiclesQuery.refetchInterval).toBe(TRANSIT_VEHICLES_POLL_MS)
    expect(TRANSIT_VEHICLES_POLL_MS).toBe(10_000)
    expect(transitVehiclesQuery.refetchIntervalInBackground).toBe(false)
  })

  test('parking refreshes on the interval the page and the map layer used to share, only while visible', () => {
    expect(parkingQuery.refetchInterval).toBe(PARKING_REFRESH_MS)
    expect(PARKING_REFRESH_MS).toBe(60_000)
    expect(parkingQuery.refetchIntervalInBackground).toBe(false)
  })

  test('public entries outlive the five-minute default so tomorrow still paints from them', () => {
    for (const q of [transitRoutesQuery, transitVehiclesQuery, diningQuery, parkingQuery, clubSearchQuery({})]) {
      expect(q.gcTime).toBe(QUERY_CACHE_MAX_AGE_MS)
    }
  })

  test('a club search is one entry per set of filters, shared across spellings, paged by the server answer', () => {
    expect(normalizeClubFilters({ q: '  chess ', category: 'Sports ', scope: 'indianapolis' })).toEqual({
      q: 'chess',
      category: 'Sports',
      scope: 'indianapolis',
      pageSize: 24,
    })
    expect(clubSearchQuery({ q: 'chess' }).queryKey).toEqual(clubSearchQuery({ q: ' chess ', scope: 'all' }).queryKey)
    expect(normalizeClubFilters({ pageSize: -3 })).toEqual({ q: '', category: '', scope: 'all', pageSize: 24 })
    const { getNextPageParam, initialPageParam } = clubSearchQuery({})
    expect(initialPageParam).toBe(1)
    const page = (n: number, pages: number, ok = true) => ({ ok, page: n, pages }) as never
    expect(getNextPageParam(page(1, 3), [], 1, [])).toBe(2)
    expect(getNextPageParam(page(3, 3), [], 3, [])).toBeUndefined()
    expect(getNextPageParam(page(1, 3, false), [], 1, [])).toBeUndefined()
  })
})

describe('retry policy', () => {
  test('retries a 429 and a 500, never a 404 or a 400, and stops after three failures', () => {
    expect(shouldRetry(0, new ApiError('slow down', 429, 7000))).toBe(true)
    expect(shouldRetry(0, new ApiError('slow down', 429))).toBe(true)
    expect(shouldRetry(0, new ApiError('boom', 500))).toBe(true)
    expect(shouldRetry(0, new ApiError('nope', 404))).toBe(false)
    expect(shouldRetry(0, new ApiError('bad', 400))).toBe(false)
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true)
    expect(shouldRetry(3, new ApiError('boom', 500))).toBe(false)
  })

  test('a 429 whose Retry-After is longer than the cap fails at once instead of spinning for the limiter window', () => {
    expect(MAX_RETRY_WAIT_MS).toBe(30_000)
    expect(shouldRetry(0, new ApiError('slow down', 429, MAX_RETRY_WAIT_MS))).toBe(true)
    expect(shouldRetry(0, new ApiError('slow down', 429, 15 * 60_000))).toBe(false)
  })

  test('a 429 waits what Retry-After asked, everything else backs off exponentially up to 30 s', () => {
    expect(retryDelayMs(0, new ApiError('slow down', 429, 7000))).toBe(7000)
    expect(retryDelayMs(0, new ApiError('boom', 500))).toBe(1000)
    expect(retryDelayMs(1, new ApiError('boom', 500))).toBe(2000)
    expect(retryDelayMs(2, new TypeError('Failed to fetch'))).toBe(4000)
    expect(retryDelayMs(9, new ApiError('boom', 500))).toBe(30_000)
  })

  test('the client carries the policy as its defaults', () => {
    const client = createQueryClient()
    const defaults = client.getDefaultOptions().queries!
    expect(defaults.staleTime).toBe(30_000)
    expect(defaults.refetchOnWindowFocus).toBe(true)
    expect(defaults.retry).toBe(shouldRetry)
    expect(defaults.retryDelay).toBe(retryDelayMs)
    // Offline means fail now, not pause: the pages' notices and the Tasks
    // page's device-store fallback both wait on a failure.
    expect(defaults.networkMode).toBe('always')
    expect(client.getDefaultOptions().mutations?.networkMode).toBe('always')
  })
})

describe('what reaches localStorage', () => {
  test('only successful public queries are persisted', () => {
    expect(isPublicQueryKey(['dining'])).toBe(true)
    expect(isPublicQueryKey(['transit', 'vehicles'])).toBe(true)
    expect(isPublicQueryKey(['me', 'u1', 'tasks'])).toBe(false)
    expect(isPublicQueryKey([])).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: ['dining'], state: { status: 'success' } } as never)).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ['transit', 'routes'], state: { status: 'success' } } as never)).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ['dining'], state: { status: 'error' } } as never)).toBe(false)
    expect(shouldDehydrateQuery({ queryKey: ['me', 'u1', 'tasks'], state: { status: 'success' } } as never)).toBe(false)
  })

  test('live vehicle positions are public but never persisted: stale after 10 s, they would only paint yesterday\'s buses', () => {
    expect(isPublicQueryKey(['transit', 'vehicles'])).toBe(true)
    expect(isPersistedQueryKey(['transit', 'vehicles'])).toBe(false)
    expect(isPersistedQueryKey(['transit', 'stops'])).toBe(true)
    expect(shouldDehydrateQuery({ queryKey: ['transit', 'vehicles'], state: { status: 'success' } } as never)).toBe(false)
  })

  test('the persister is skipped when storage is missing or throws', () => {
    expect(createQueryPersister(null)).toBeNull()
    const broken = {
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    } as unknown as Storage
    expect(createQueryPersister(broken)).toBeNull()
    expect(createQueryPersister(window.localStorage)).not.toBeNull()
  })

  test('the build id is a non-empty string', () => {
    expect(typeof BUILD_ID).toBe('string')
    expect(BUILD_ID.length).toBeGreaterThan(0)
  })

  test('a restored row keeps the 24 h gcTime, so an entry no page opens this launch is still there next launch', () => {
    const source = new QueryClient()
    source.setQueryData(['parking'], { garages: [] })
    const persisted = dehydrate(source, { shouldDehydrateQuery: () => true })

    const restored = createQueryClient()
    hydrate(restored, persisted, hydrateOptions)
    expect(restored.getQueryCache().find({ queryKey: ['parking'] })?.gcTime).toBe(QUERY_CACHE_MAX_AGE_MS)

    // Without the option the row would get the five-minute default and be
    // collected, and dropped from storage on the next save, before its page
    // was opened.
    const bare = createQueryClient()
    hydrate(bare, persisted)
    expect(bare.getQueryCache().find({ queryKey: ['parking'] })?.gcTime).toBe(5 * 60_000)
  })

  test('mutations are never persisted: a paused task tick would carry the user\'s metadata in its variables and snapshot', () => {
    const client = createQueryClient()
    const mutation = client.getMutationCache().build(client, { mutationKey: ['toggle'], mutationFn: async () => undefined })
    expect(dehydrateOptions.shouldDehydrateMutation?.(mutation as never)).toBe(false)
    expect(dehydrate(client, dehydrateOptions).mutations).toEqual([])
  })
})

describe('fetchJson', () => {
  test('returns the JSON body on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, locations: [] })))
    await expect(fetchJson('/api/dining')).resolves.toEqual({ ok: true, locations: [] })
  })

  test('a 429 becomes an ApiError carrying the limiter message and Retry-After in milliseconds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Too many requests. Please try again shortly.', status: 429 } }), {
        status: 429,
        headers: { 'Retry-After': '7' },
      }),
    )
    const error = (await fetchJson('/api/transit/vehicles').catch((e: unknown) => e)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(429)
    expect(error.retryAfterMs).toBe(7000)
    expect(error.message).toBe('Too many requests. Please try again shortly.')
  })

  test('other failures read a string error, fall back to a generic message, and carry no delay', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'Failed to fetch parking status' }), { status: 500 }))
    const error = (await fetchJson('/api/parking/garages').catch((e: unknown) => e)) as ApiError
    expect(error.message).toBe('Failed to fetch parking status')
    expect(error.retryAfterMs).toBeUndefined()

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502 }))
    const generic = (await fetchJson('/api/transit/routes').catch((e: unknown) => e)) as ApiError
    expect(generic.message).toBe('Request failed (502)')
    expect(errorMessage(generic, 'fallback')).toBe('Request failed (502)')
    expect(errorMessage(null, 'fallback')).toBe('fallback')
  })

  test('Retry-After accepts delta seconds and an HTTP date', () => {
    expect(retryAfterMsFromHeader('12')).toBe(12_000)
    const now = Date.parse('2026-09-24T12:00:00Z')
    expect(retryAfterMsFromHeader('Thu, 24 Sep 2026 12:00:30 GMT', now)).toBe(30_000)
    expect(retryAfterMsFromHeader('Thu, 24 Sep 2026 11:00:00 GMT', now)).toBe(0)
    expect(retryAfterMsFromHeader('soon')).toBeUndefined()
    expect(retryAfterMsFromHeader(null)).toBeUndefined()
  })
})

describe('refreshDining', () => {
  test('bypasses the cache with ?refresh=1 and lands the answer in the shared entry', async () => {
    const snapshot = { ok: true, date: '2026-09-24', locations: [] }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(snapshot)))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(diningQuery.queryKey, { ok: true, date: '2026-09-23', locations: [] })
    await expect(refreshDining(client)).resolves.toEqual(snapshot)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/dining?refresh=1')
    expect(client.getQueryData(diningQuery.queryKey)).toEqual(snapshot)
  })

  test('a failed refresh rejects and leaves the entry as it was', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'dining_internal' }), { status: 500 }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const before = { ok: true, date: '2026-09-23', locations: [] }
    client.setQueryData(diningQuery.queryKey, before)
    await expect(refreshDining(client)).rejects.toBeInstanceOf(ApiError)
    expect(client.getQueryData(diningQuery.queryKey)).toEqual(before)
  })
})
