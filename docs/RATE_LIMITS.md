# API Rate Limiting

BoilerIndy protects its backend with configurable, in-memory rate limiting
(implemented in [`rateLimiter.mjs`](../src/rateLimiter.mjs)). Buckets are keyed by
the signed-in user id when a session exists, otherwise by client IP.

When a limit is hit the API responds `429` with a user-friendly message,
standard `RateLimit-*` headers, and a `Retry-After` header. The first blocked
request per window is logged to the server console with the offending key,
method, and path for abuse review.

## Endpoint coverage

| Limiter | Endpoints | Default limit | Window | Keyed by |
|---|---|---|---|---|
| `sign-in` | `POST /api/auth/sign-in` | 20 | 15 min | IP |
| `account-create` | `POST /api/auth/sign-up`, `POST /api/auth/register-supabase` | 10 | 1 hour | IP |
| `session-sync` | `POST /api/auth/supabase-sync` | 120 | 15 min | Supabase user (`sub` of the request's token, or `supabaseUserId`), falls back to IP (#217) |
| `session-sync-ip` | `POST /api/auth/supabase-sync` (outer cap so one address cannot mint unlimited user buckets) | 600 | 15 min | IP |
| `purdue-link-token` | `POST /api/purdue/link-token` (native app Purdue link handoff, issue #214) | 20 | 15 min | user, falls back to IP |
| `purdue-link-flow` | `GET /auth/purdue/connect`, `POST /auth/purdue/dev/link`, `GET /auth/purdue/callback` (the steps that spend a link attempt, checked before the student is loaded; a blocked caller is redirected, to the app with `reason=rate-limited` or to `/settings?error=purdue-link-throttled`, rather than answered with a JSON 429; issue #293) | 30 | 15 min | handoff token (only a validly signed, unexpired, unspent one), then user, then IP |
| `board-write` | `POST /api/board/posts`, `POST /api/board/posts/:id/reply`, `POST /api/board/posts/:id/upvote`, `PATCH /api/board/posts/:id` | 30 | 10 min | user, falls back to IP |
| `source-sync` | `POST /api/sync/:sourceId`, `POST /api/sources/purdue/schedule`, `POST /api/sources/brightspace/schedule` | 30 | 15 min | user, falls back to IP |
| `marketplace-read` | `GET /api/marketplace/:id` (reveals seller email, enumeration-sensitive) | 100 | 15 min | user, falls back to IP |
| `public-read` | `GET /api/dining`, `GET /api/transit/stops`, `GET /api/transit/routes`, `GET /api/parking/garages`, `GET /api/push/config` (session-free reads) | 120 | 15 min | user, falls back to IP (#215) |
| `transit-vehicles` | `GET /api/transit/vehicles` (polled every 10 to 20 s per open Transit screen; also served with `Cache-Control: public, max-age=10, s-maxage=10` so browsers and the Vercel edge absorb repeats) | 240 | 15 min | user, falls back to IP |
| `clubs-read` | `GET /api/clubs` (club directory search; served from an hours-long cache, never hits BoilerLink per request, but search-as-you-type sends several requests per query) | 300 | 15 min | IP |
| `push-write` | `PUT /api/push/settings`, `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions` | 30 | 15 min | user, falls back to IP |
| `push-test` | `POST /api/push/test` (sends a real notification to every registered device) | 10 | 1 hour | user, falls back to IP |
| `user-write` | Every non-GET `/api/me/*` route without a bucket of its own: `POST /api/me/tasks/calendar/complete`, `POST /api/me/tasks/manual`, `PATCH` and `DELETE /api/me/tasks/manual/:id`, `POST /api/me/grades`, `PATCH` and `DELETE /api/me/grades/:id`, `PUT /api/me/degree`, `POST /api/me/calendar-feed/token`, `PUT /api/me/dashboard`, `PUT /api/me/services`, `POST` and `DELETE /api/me/dining/favorites`, `PATCH /api/me/study-groups/opt-in` (`PATCH /api/me/profile` and `POST /api/me/delete-account` stay on `sign-in`, `PUT /api/me/profile-card` on `board-write`). Also the owner-or-admin deletes `DELETE /api/sources/:sourceId`, `/api/lost-found/:id`, `/api/board/posts/:id`, `/api/guide/:id`, `/api/study-groups/:id` and `/api/marketplace/:id`, plus `PATCH /api/guide/:id/pin`, `PATCH /api/connections/:requesterId`, `POST /api/purdue/mock-link` and the admin deal writes `POST /api/deals`, `PATCH` and `DELETE /api/deals/:id` (#202) | 120 | 15 min | user, falls back to IP |
| `advertiser-write` | `POST /api/advertiser/campaigns`, `PATCH /api/advertiser/campaigns/:id` (#202) | 60 | 15 min | advertiser portal session (`req.session.advertiserId`), falls back to IP |
| AI assistant (pre-existing) | `POST /api/assistant` | 10 | 1 hour | user, falls back to IP |
| AI board suggestions (pre-existing) | `POST /api/board/ai-suggestions` | 10 | 1 hour | user |

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
cap is reached (#202). Two requests racing past the cap can land one row over
it, which is accepted. The caps are constants in
[`userWriteCaps.mjs`](../src/userWriteCaps.mjs), not environment variables.

| Route | Cap | Counted per |
|---|---|---|
| `POST /api/me/tasks/manual` | 500 manual tasks | user |
| `POST /api/me/grades` | 500 courses | user |
| `POST /api/me/dining/favorites` | 300 favorites (re-saving one the user already has still succeeds at the cap) | user |
| `POST /api/advertiser/campaigns` | 20 campaigns in `draft` (campaigns pending review, active, paused or ended do not count) | advertiser |

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

Marketplace photo authorization uses `marketplace-photo`: 20 requests per hour
per signed-in user on `POST /api/marketplace/photos/authorize`. Override using
`RATE_LIMIT_MARKETPLACE_PHOTO_MAX` and `RATE_LIMIT_MARKETPLACE_PHOTO_WINDOW_MS`.
Like the other in-memory limits, this budget is per process and resets on restart.
See [photo setup and lifecycle](marketplace-photos.md).
