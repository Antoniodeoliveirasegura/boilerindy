# API Rate Limiting

BoilerIndy protects its backend with configurable, in-memory rate limiting
(implemented in [`rateLimiter.mjs`](../src/rateLimiter.mjs)). Buckets are keyed by
the signed-in user id when a session exists, otherwise by client IP.

When a limit is hit the API responds `429` with a user-friendly message,
standard `RateLimit-*` headers, and a `Retry-After` header. The first blocked
request per window is logged to the server console with the offending key,
method, and path for abuse review.

## Endpoint coverage

Every bucket below is a `createRateLimiter` call in `server.mjs`, except the two
AI limits and `purdue-link-flow`, which are noted as such.
[`rateLimitDocs.test.mjs`](../test/rateLimitDocs.test.mjs) fails the build when a
limiter or one of its routes is missing from this table, or when the table names
a route the server does not serve, so it cannot drift from the code again (#201).

| Limiter | Endpoints | Default limit | Window | Keyed by |
|---|---|---|---|---|
| `sign-in` | `POST /api/auth/sign-in`, `PATCH /api/me/profile`, `POST /api/me/delete-account`, `POST /api/advertiser/sign-in` | 20 | 15 min | IP |
| `account-create` | `POST /api/auth/register-supabase`, `POST /api/advertiser/request-access` | 10 | 1 hour | IP |
| `password-reset` | `POST /api/advertiser/forgot-password`, `POST /api/advertiser/reset-password` | 10 | 1 hour | IP |
| `session-sync` | `POST /api/auth/supabase-sync` (the inner per-user cap) | 120 | 15 min | Supabase user (`sub` of the request's token, or `supabaseUserId`), falls back to IP (#217) |
| `session-sync-ip` | `POST /api/auth/supabase-sync` (outer cap so one address cannot mint unlimited user buckets) | 600 | 15 min | IP |
| `purdue-link-token` | `POST /api/purdue/link-token` (native app Purdue link handoff, issue #214) | 20 | 15 min | user, falls back to IP |
| `purdue-link-flow` | `GET /auth/purdue/connect`, `POST /auth/purdue/dev/link`, `GET /auth/purdue/callback` (the steps that spend a link attempt, checked before the student is loaded; a blocked caller is redirected, to the app with `reason=rate-limited` or to `/settings?error=purdue-link-throttled`, rather than answered with a JSON 429; issue #293) | 30 | 15 min | handoff token (only a validly signed, unexpired, unspent one), then user, then IP |
| `board-write` | `POST /api/board/posts`, `POST /api/board/posts/:id/reply`, `POST /api/board/posts/:id/upvote`, `PATCH /api/board/posts/:id`, `POST /api/guide`, `POST /api/guide/:id/upvote`, `POST /api/study-groups`, `POST /api/study-groups/:id/join`, `POST /api/study-groups/:id/leave`, `POST /api/marketplace`, `PATCH /api/marketplace/:id`, `POST /api/marketplace/:id/report`, `PUT /api/me/profile-card`, `POST /api/connections` | 30 | 10 min | user, falls back to IP |
| `lost-found-write` | `POST /api/lost-found`, `PATCH /api/lost-found/:id` | 30 | 10 min | user, falls back to IP |
| `user-write` | `POST /api/purdue/mock-link`, `DELETE /api/sources/:sourceId`, `POST /api/me/tasks/calendar/complete`, `POST /api/me/tasks/manual`, `PATCH /api/me/tasks/manual/:id`, `DELETE /api/me/tasks/manual/:id`, `POST /api/me/grades`, `PATCH /api/me/grades/:id`, `DELETE /api/me/grades/:id`, `PUT /api/me/degree`, `PUT /api/me/schedule-overrides`, `POST /api/me/calendar-feed/token`, `DELETE /api/lost-found/:id`, `PUT /api/me/dashboard`, `PUT /api/me/services`, `POST /api/me/dining/favorites`, `DELETE /api/me/dining/favorites`, `DELETE /api/board/posts/:id`, `PATCH /api/guide/:id/pin`, `DELETE /api/guide/:id`, `PATCH /api/me/study-groups/opt-in`, `DELETE /api/study-groups/:id`, `POST /api/deals`, `PATCH /api/deals/:id`, `DELETE /api/deals/:id`, `DELETE /api/marketplace/:id`, `PATCH /api/connections/:requesterId` | 120 | 15 min | user, falls back to IP |
| `advertiser-write` | `POST /api/advertiser/campaigns`, `PATCH /api/advertiser/campaigns/:id` | 60 | 15 min | advertiser portal session (`req.session.advertiserId`), falls back to IP |
| `source-sync` | `POST /api/sources/purdue/schedule`, `POST /api/sources/brightspace/schedule`, `POST /api/sync/:sourceId` | 30 | 15 min | user, falls back to IP |
| `public-read` | `GET /api/transit/stops`, `GET /api/transit/routes`, `GET /api/parking/garages`, `GET /api/push/config`, `GET /api/dining` (session-free upstream proxies, #215; registered before the session middleware so their responses never set a cookie and the Vercel edge can store them, #250) | 120 | 15 min | hash of the session cookie when the request carries one, falls back to IP (#250) |
| `public-read-ip` | `GET /api/transit/stops`, `GET /api/transit/routes`, `GET /api/parking/garages`, `GET /api/push/config`, `GET /api/dining` (outer cap so one address cannot mint unlimited cookie buckets) | 1200 | 15 min | IP |
| `transit-vehicles` | `GET /api/transit/vehicles` (polled every 10 to 20 s per open Transit screen; also served with `Cache-Control: public, max-age=10, s-maxage=10, stale-while-revalidate=20` so browsers and the Vercel edge absorb repeats) | 240 | 15 min | hash of the session cookie when the request carries one, falls back to IP (#250) |
| `transit-vehicles-ip` | `GET /api/transit/vehicles` (outer cap so one address cannot mint unlimited cookie buckets) | 2400 | 15 min | IP |
| `clubs-read` | `GET /api/clubs` (served from an hours-long cache, but search-as-you-type sends several requests per query) | 300 | 15 min | IP |
| `marketplace-read` | `GET /api/marketplace/:id` (reveals the seller's email, so enumeration-sensitive, #114) | 100 | 15 min | user, falls back to IP |
| `marketplace-photo` | `POST /api/marketplace/photos/authorize` (see [photo setup and lifecycle](marketplace-photos.md)) | 20 | 1 hour | user, falls back to IP |
| `calendar-feed` | `GET /feeds/calendar/:file` (the signed feed URL a calendar app polls; no session, so the token is the only credential) | 60 | 15 min | IP |
| `push-write` | `PUT /api/push/settings`, `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions` | 30 | 15 min | user, falls back to IP |
| `push-test` | `POST /api/push/test` (sends a real notification to every registered device) | 10 | 1 hour | user, falls back to IP |
| `ad-event` | `POST /api/spotlight/:campaignId/event` (impression and click beacons from the spotlight rails, one per ad shown) | 200 | 5 min | user, falls back to IP |
| `analytics` | `POST /api/usage/events` (the first-party usage beacon, batched by the client, #51) | 60 | 5 min | user, falls back to IP |
| `admin-write` | `PATCH /api/admin/leads/:id`, `PATCH /api/admin/campaigns/:id`, `POST /api/admin/advertisers`, `POST /api/admin/purdue-links/clear`, `POST /api/admin/deleted/:type/:id/restore`, `DELETE /api/admin/deleted/:type/:id`, `POST /api/admin/hidden/marketplace/:id/unhide`, `POST /api/admin/hidden/marketplace/:id/takedown` | 60 | 15 min | user, falls back to IP |
| `ai-assistant` | `POST /api/assistant` (metered only while a Groq key is configured; the offline router's answers are free. Keeps its pre-envelope 429 body, a string `error`, which the assistant panel renders) | 40 | 1 hour | user, falls back to IP |
| `ai-board` | `POST /api/board/ai-suggestions` | 30 | 1 hour | user, falls back to IP |
| `ai-board-tags` (a `createRateWindow`, not a middleware: the auto-tagger inside `POST /api/board/posts` skips its inference call over the limit, and the post is saved untagged) | `POST /api/board/posts` | 30 | 1 hour | user |

Read-only endpoints (`GET /api/...`) are generally not limited: they are
session-gated, cheap, and limiting them would hurt normal navigation. Two
exceptions: the session-free upstream proxies (dining, transit, parking) use
the `public-read` bucket (vehicles have their own) so an anonymous client cannot
burn the upstream quota,
and `GET /api/marketplace/:id`, which returns the seller's contact
email and is therefore enumeration-sensitive; `marketplace-read` throttles the
bulk id-sweeps that would harvest every seller's address (#114).

### Row caps

A rate limit slows a script down; a row cap bounds what it can store. These
create routes count the caller's rows right before the insert and answer `409`
with the standard error shape, `{ error: { message, status: 409 } }`, once the
cap is reached (#202). The caps are constants in
[`userWriteCaps.mjs`](../src/userWriteCaps.mjs), not environment variables.

The count is not atomic with the insert. Parallel requests that all count
before any of them inserts each get through, so one burst can overshoot a cap
by nearly the write limiter's whole remaining budget (`user-write` allows 120
requests per 15 minutes and `advertiser-write` 60, counted per server
instance); the first request after the burst is refused. That race is
accepted. A count query that fails does not block the write either: the route
logs the failure with its HTTP status and goes on to the insert.

| Route | Cap | Counted per |
|---|---|---|
| `POST /api/me/tasks/manual` | 500 manual tasks | user |
| `POST /api/me/grades` | 500 courses | user |
| `POST /api/me/dining/favorites` | 300 favorites (re-saving one the user already has still succeeds at the cap) | user |
| `POST /api/advertiser/campaigns` | 20 campaigns in `draft` (campaigns pending review, active, paused or ended do not count) | advertiser |

The draft cap does not bound the admin review queue. An advertiser who submits
or ends each draft frees its slot, so a create-then-submit loop can keep adding
`pending_review` campaigns, slowed only by `advertiser-write` (about 30 pairs
per 15 minutes). `GET /api/admin/campaigns` returns the newest 200 rows, so a
long loop can push genuine submissions out of that view. Capping pending or
total campaigns per advertiser is an open owner decision.

### How the web app handles a refusal

The React client treats any `4xx` from a write as the server refusing that one
request, not as being offline
([`writeFailure.ts`](../boilerindy-react/src/lib/writeFailure.ts), #202). The
page stays online, undoes what it showed optimistically and shows the
response's `error.message`, so a `409` cap or a `429` limit reads the same as
the server wrote it. Only a request that got no response, or a `5xx`, keeps a
page's offline behaviour: Assignments switches to device-only tasks, the grade
tracker keeps its local copy, and the dashboard and Services layouts and the
selected major stay in the local cache until the next successful save. A
refused layout or major save puts back the value the server last accepted.

## Configuration

Every limiter can be tuned through environment variables - no code changes:

```bash
RATE_LIMIT_ENABLED=false              # master switch (default: true)
RATE_LIMIT_<NAME>_MAX=<n>             # request budget per window
RATE_LIMIT_<NAME>_WINDOW_MS=<ms>      # window length in milliseconds
```

`<NAME>` is the limiter name upper-cased with non-alphanumerics replaced by
`_`, e.g. `board-write` → `RATE_LIMIT_BOARD_WRITE_MAX`.

## Notes / limitations

- Counters live in process memory: restarting the server resets all windows,
  and multi-instance deployments count per instance. Move the store to Redis
  (or similar) before scaling horizontally.
- When deploying behind a reverse proxy or CDN, configure Express
  `trust proxy` so `req.ip` reflects the real client address; otherwise all
  anonymous traffic shares one bucket.
- The public reads (`public-read`, `public-read-ip`, `transit-vehicles`,
  `transit-vehicles-ip`) answer with `Cache-Control: public` and run before the
  session middleware, so the Vercel edge can serve signed-in polls too. An
  edge hit never reaches this process and does not count against any bucket
  (#250).
