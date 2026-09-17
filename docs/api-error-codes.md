# API error codes

The standard JSON error envelope, used by new code and by every code in the
table below:

```json
{ "error": { "message": "The marketplace is not set up yet. Please try again later.", "code": "marketplace_schema_missing", "status": 503 } }
```

- `message` is written for the person using the app. The answers from
  `src/dbErrors.mjs` (every `*_schema_missing` code and the 500s next to them)
  never put SQL, table names or setup instructions in it. Some older routes
  still do, see [Older error shapes](#older-error-shapes).
- `status` repeats the HTTP status.
- `code` is optional. It is present only where a client is expected to branch,
  and a code never changes meaning once shipped. A client that does not know a
  code falls back to the HTTP status and `message`.

Not every route has moved to this envelope yet, so a client should read
`error.status` and `error.code` only when `error` is an object.

## Codes

| Code | Status | Emitted by | Meaning | What clients should do |
|---|---|---|---|---|
| `board_schema_missing` | 503 | `/api/board/posts*` | Campus board tables are not in the database yet. | Show the board as "coming soon"; do not retry in a loop. |
| `guide_schema_missing` | 503 | `/api/guide*` | Neighborhood Guide tables are missing. | Same "coming soon" state for the guide. |
| `study_groups_schema_missing` | 503 | `/api/study-groups*`, `/api/me/study-groups*` | Study group tables are missing, or (on `DELETE /api/study-groups/:id`) the soft-delete migration has not run. | "Coming soon" for study groups; on delete, show the message and keep the group. |
| `deals_schema_missing` | 503 | `/api/deals*` | Campus Perks tables are missing. | "Coming soon" for perks. |
| `marketplace_schema_missing` | 503 | `/api/marketplace*` (not `/api/marketplace/capabilities`, see below) | Marketplace tables are missing. | "Coming soon" for the marketplace. |
| `friends_schema_missing` | 503 | `/api/me/profile-card`, `/api/me/matches`, `/api/connections*`, `/api/me/connections` | Friend matching tables are missing. | "Coming soon" for friend matching. |
| `advertiser_schema_missing` | 503 | `/api/advertiser/*`, and the portal admin routes `/api/admin/overview`, `/api/admin/leads*`, `/api/admin/campaigns*`, `/api/admin/advertisers` | Advertiser portal tables (portal, campaigns or password resets) are missing. | Show the portal as unavailable. |
| `moderation_schema_missing` | 503 | `/api/admin/deleted/:type*`, `/api/admin/content/:type/:id` | That content type has no `deleted_at` column yet: `db/supabase-study-groups-soft-delete.sql` for `study-groups`, `db/supabase-soft-delete.sql` for every other type. | Admin view: show the message for that type. Retrying does not help until the migration runs; the message does not name the file (see below). |
| `push_not_configured` | 503 | `/api/push/*` | Push tables are missing (`db/supabase-push.sql`). Its message still names that file. | Show notifications as not set up (the website Settings card does). |
| `push_disabled` | 503 | `/api/push/*` | The server has no VAPID keys. | Treat push as switched off. |
| `purdue_linking_disabled` | 400 | `POST /api/purdue/link-token` | `PURDUE_AUTH_MODE=off`. | Hide the Purdue link option. See [purdue-link.md](purdue-link.md). |
| `purdue_link_unconfigured` | 503 | `POST /api/purdue/link-token` | `SESSION_SECRET` is shorter than 32 characters. | Show linking as unavailable. |
| `purdue_link_unauthorized` | 401 | `POST /api/purdue/link-token` | The session has no valid student id. | Send the student to sign in again. |

Every `*_schema_missing` code ends in `_schema_missing`, so a client can match
the suffix instead of listing features: the mobile app maps `503` plus that
suffix to its "coming soon" state.

## Schema-missing answers (issue #218)

`src/dbErrors.mjs` owns these responses. `DB_FEATURES` lists each feature's
key (the code prefix), the subject of the client message, the SQL file(s) that
create its tables, and the 500 fallback message. The route helpers in
`server.mjs` (`respondBoardDbError`, `respondMarketplaceDbError` and the rest)
are thin wrappers over `respondDbError`.

- A missing table or column answers `503` with the feature's code and the
  message `<Feature> is not set up yet. Please try again later.` That is
  PostgREST `PGRST205` or `PGRST204`, Postgres `42P01` or `42703`, or, for an
  error without one of those codes, a "schema cache", "Could not find the table"
  or "relation/column ... does not exist" message.
- A missing function, operator or type (Postgres `42883`, `42704`, such as
  `operator does not exist: uuid = text`) is a bug in the query, not a migration
  that has not run, so it takes the `500` path below.
- The SQL file to run is logged instead of sent, once per feature, file and
  error code per server process, so Render logs and Sentry get it once rather
  than on every request, and a new cause (a missing column after a missing
  table) still gets its own line. Look for a line like
  `[marketplace] schema missing: run db/supabase-marketplace.sql in the Supabase SQL Editor, then retry.`
  followed by the database error code and message. Restarting the server logs it
  again on the next hit.
- The admin moderation routes follow the same rule, so the Deleted content page
  shows `<Type> moderation is not set up yet.` without the file name. The files
  are listed in the `moderation_schema_missing` row above.
- Any other database error answers `500` with the feature's fallback message and
  no code. The log line is `<feature> DB error: <code> <message>`, written on
  every hit; `details` and `hint` are never logged, because they can hold row
  values.

To give a new feature a code, add an entry to `DB_FEATURES`, call
`respondDbError(res, err, DB_FEATURES.<key>)` from its routes, and add a row to
the table above.

## 503s without a code

These are temporary or configuration states that are not tied to a missing
table. Show the message and let the student retry later.

- `POST /api/auth/sign-in`: Supabase Auth is unreachable.
- `POST /api/board/ai-suggestions`: no Groq key on the server.
- `GET /api/transit/*`: transit is not configured.
- `GET /api/marketplace/capabilities`: the gallery and pricing columns are not
  there yet; both clients hold off on galleries and price choices.
- Marketplace photo routes: photo storage is unavailable or not configured.

## Older error shapes

These routes predate the envelope rules above. Until they move over, a client
must not assume `error` is an object or that its `message` is safe to show.

- `push_not_configured`: the message names `db/supabase-push.sql`.
- Manual tasks (`/api/me/tasks/calendar/complete`, `/api/me/tasks/manual*`),
  grades (`/api/me/grades*`) and dining favorites (`/api/me/dining/favorites`)
  answer `500 { error: { message } }` with the raw database message and no
  `status` (issue #206). Several account and calendar-source routes also pass
  the underlying error's message through.
- `POST /api/assistant`, `GET /api/parking/garages` and `GET /api/clubs` answer
  `{ error: "<text>" }`.
- `GET /api/dining` answers `{ ok: false, error: "dining_bad_date" | "dining_internal", locations: [] }`
  (see [dining.md](dining.md)).
- The cron routes `POST /api/internal/push/run-reminders` and
  `POST /api/internal/sources/resync` answer `{ ok: false, error: "<text>" }`.

## Website client

`authRequest` (`boilerindy-react/src/lib/authApi.ts`) throws an `Error` with
`status`, the raw `payload`, and `code` copied from `payload.error.code` when it
is a string, so a page can check `error.code?.endsWith('_schema_missing')`.
