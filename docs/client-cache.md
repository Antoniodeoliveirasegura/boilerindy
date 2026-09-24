# Client data cache

The React app reads its public data through one TanStack Query client, with the
answers persisted to localStorage, so the dashboard paints the last known
shuttles, menus and garages before the backend answers, and Home and Transit
share one entry per dataset instead of each fetching their own (issue #251).
The server half of the same idea, the Vercel edge cache on `/api`, is in
[RATE_LIMITS.md](RATE_LIMITS.md) and issue #250; the two are complementary.

## Where it lives

- `boilerindy-react/src/lib/queryClient.ts`: the client, its retry policy, the
  localStorage persister and the rule for what may be persisted.
- `boilerindy-react/src/lib/queries/publicData.ts`: the keys, stale times,
  polling and hooks for the five public reads, and `fetchJson`, which every
  query uses.
- `boilerindy-react/src/main.tsx`: the provider, above `AuthProvider`, so a
  later sign-out can clear the client.

## Keys and stale times

A cached answer is served without a network request for its stale time; after
that the next mount or window focus refetches in the background while the old
answer stays on screen.

| Key | Route | Stale | Polling |
|---|---|---|---|
| `['transit', 'routes']` | `GET /api/transit/routes` | 10 min | none |
| `['transit', 'stops']` | `GET /api/transit/stops` | 10 min | none |
| `['transit', 'vehicles']` | `GET /api/transit/vehicles` | 10 s | every 10 s while a Transit screen or the dashboard is open and the tab is visible |
| `['dining']` | `GET /api/dining` | 5 min | none; the Dining page's Refresh button fetches `?refresh=1` and writes the answer into this entry |
| `['parking']` | `GET /api/parking/garages` | 60 s | every 60 s while the parking page or the map's garage layer is open and the tab is visible |
| `['clubs', filters]` | `GET /api/clubs?...` | 30 min | none; one entry per set of filters holds every page fetched so far, and "Show more" appends the next |

`refetchIntervalInBackground` is off for the two polls, so a hidden tab stops
them (and stops spending the `transit-vehicles` budget); TanStack resumes them
when the tab is visible again. Public entries stay in memory for 24 hours
rather than TanStack's five-minute default, because the point is that a
dashboard opened tomorrow still paints from them.

Pages keep their own loading and error states, driven by the query: `isPending`
is the first load, `isError` is a notice beside whatever data is on screen (a
failed refetch never blanks a widget), and `dataUpdatedAt` feeds the "Updated
12:04" stamps.

## Retries

`fetchJson` throws an `ApiError` with the HTTP status for any non-2xx answer
and, on a 429, the limiter's `Retry-After` in milliseconds. The client retries
network failures, 5xx answers and 429s up to three times; a 429 waits exactly
what the limiter asked, everything else backs off 1 s, 2 s, 4 s (capped at
30 s). Other 4xx answers never retry. A 429 whose `Retry-After` is longer
than 30 s is not retried at all: the limiters' windows are 15 minutes, and a
first load must show the limiter's message rather than a spinner for that
long. Retries only ever delay the first paint; once an entry holds data, a
failing refetch leaves it on screen.

## What is persisted, and why per-user data is not

Only successful queries whose key starts with `transit`, `dining`, `parking` or
`clubs` are written to localStorage (`shouldDehydrateQuery` in
`queryClient.ts`), under the key `boilerindy-query-cache`. This is public data,
identical for every student, so a device can hold it without knowing who is
signed in. One public entry is left out on purpose: `['transit', 'vehicles']`.
Live positions are stale after 10 s, so persisting them would only paint
yesterday's buses on the map for a moment, and re-serialising the whole cache
on every 10 s poll is work nobody benefits from. Per-user reads (calendar items, tasks, layouts) follow in phase 2
(issue #327): their keys will carry the user id, they will be excluded from
persistence, and the client will be cleared on sign-out, the same rule the
per-user localStorage stores already follow.

Two guards on the persisted rows:

- `maxAge` is 24 hours: older rows are dropped on restore.
- `buster` is a build id minted by `vite.config.js` (`define`, `__BUILD_ID__`)
  on every build, so a deploy discards the previous build's rows. That is what
  protects the UI from a persisted response shape it no longer expects.

Where localStorage is missing or throws at startup (private mode), the app
runs the same client without a persister and nothing else changes. When the
serialised cache later outgrows the quota, the persister drops the oldest
queries and saves again (`removeOldestQuery`) rather than failing silently on
every save from then on.
