import { QueryClient, type Query } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { removeOldestQuery, type Persister } from '@tanstack/react-query-persist-client'

// The one client-side data layer (issue #251): TanStack Query with the public
// reads persisted to localStorage, so the installed app paints the last known
// shuttles, menus and garages before Render answers (or wakes up).
//
// Only public data is ever written to storage. Per-user queries (phase 2,
// #327) carry the user id in their key and are excluded here, and the client
// is cleared on sign-out. docs/client-cache.md has the full map.

/** Key roots whose queries may be persisted: public, identical for everyone. */
export const PUBLIC_QUERY_ROOTS = ['transit', 'dining', 'parking', 'clubs'] as const

export const QUERY_CACHE_KEY = 'boilerindy-query-cache'

/** Persisted rows older than this are dropped on restore. */
export const QUERY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The longest Retry-After a 429 is waited out for. The limiters' windows are
 * 15 minutes, and a first load must not sit on a spinner for that long: past
 * this the query fails at once and the page shows the limiter's message.
 */
export const MAX_RETRY_WAIT_MS = 30_000

/** Public keys that are never written to storage: live positions are stale after 10 s and would only paint yesterday's buses. */
const NEVER_PERSISTED = [['transit', 'vehicles']] as const

/**
 * Minted per build in vite.config.js (`define`). Every deploy discards the
 * previous build's persisted rows, which is what protects the UI from a
 * persisted response shape it no longer expects. Tests and any environment
 * without the define fall back to a constant.
 */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

/** What the fetchers attach to a failure. Duck-typed on purpose: phase 2's authRequest errors carry `status` too. */
export type QueryFailure = { status?: number; retryAfterMs?: number }

/**
 * Retry network failures and server errors up to three times; never retry a
 * client error, except a 429, which is the limiter asking for patience.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false
  const failure = (error as QueryFailure | null) ?? {}
  const { status, retryAfterMs } = failure
  if (status === 429) return retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_WAIT_MS
  if (status !== undefined && status >= 400 && status < 500) return false
  return true
}

/** Honour the limiter's Retry-After when there is one, else back off exponentially, capped at 30 s. */
export function retryDelayMs(attempt: number, error: unknown): number {
  const retryAfterMs = (error as QueryFailure | null)?.retryAfterMs
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs
  return Math.min(1000 * 2 ** attempt, 30_000)
}

export function isPublicQueryKey(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0]
  return typeof root === 'string' && (PUBLIC_QUERY_ROOTS as readonly string[]).includes(root)
}

/** Public and worth keeping across visits: everything public except the live vehicle positions. */
export function isPersistedQueryKey(queryKey: readonly unknown[]): boolean {
  if (!isPublicQueryKey(queryKey)) return false
  return !NEVER_PERSISTED.some((excluded) => excluded.every((part, i) => queryKey[i] === part))
}

/** Persist a query only when it succeeded and holds public data worth keeping. */
export function shouldDehydrateQuery(query: Pick<Query, 'queryKey' | 'state'>): boolean {
  return query.state.status === 'success' && isPersistedQueryKey(query.queryKey)
}

export const dehydrateOptions = { shouldDehydrateQuery }

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: shouldRetry,
        retryDelay: retryDelayMs,
      },
    },
  })
}

/**
 * The localStorage persister, or null where storage is missing or throws
 * (private mode, a full quota): the app then runs with an in-memory cache and
 * nothing else changes.
 */
export function createQueryPersister(storage: Storage | null = safeLocalStorage()): Persister | null {
  if (!storage) return null
  try {
    const probe = `${QUERY_CACHE_KEY}-probe`
    storage.setItem(probe, '1')
    storage.removeItem(probe)
  } catch {
    return null
  }
  // When the serialised cache outgrows the quota, drop the oldest queries
  // and save again rather than failing silently on every save from then on.
  return createSyncStoragePersister({ storage, key: QUERY_CACHE_KEY, throttleTime: 250, retry: removeOldestQuery })
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}
