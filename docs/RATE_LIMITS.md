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
| `session-sync` | `POST /api/auth/supabase-sync` | 120 | 15 min | IP |
| `board-write` | `POST /api/board/posts`, `POST /api/board/posts/:id/reply`, `POST /api/board/posts/:id/upvote`, `PATCH /api/board/posts/:id` | 30 | 10 min | user, falls back to IP |
| `source-sync` | `POST /api/sync/:sourceId`, `POST /api/sources/purdue/schedule`, `POST /api/sources/brightspace/schedule` | 30 | 15 min | user, falls back to IP |
| Gemini assistant (pre-existing) | `POST /api/assistant` | 10 | 1 hour | user, falls back to IP |
| Gemini board AI (pre-existing) | `POST /api/board/ai-suggestions` | 10 | 1 hour | user |

Read-only endpoints (`GET /api/...`) are intentionally not limited: they are
session-gated, cheap, and limiting them would hurt normal navigation.

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
