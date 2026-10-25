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
| `board_schema_missing` | 503 | `/api/board/posts*` | Campus board tables, or their `deleted_at` column, are not in the database yet. | Show the board as "coming soon"; do not retry in a loop. |
| `guide_schema_missing` | 503 | `/api/guide*` | Neighborhood Guide tables, or their `deleted_at` column, are missing. | Same "coming soon" state for the guide. |
| `study_groups_schema_missing` | 503 | `/api/study-groups*`, `/api/me/study-groups*` | Study group tables are missing, or (on `DELETE /api/study-groups/:id`) the soft-delete migration has not run. | "Coming soon" for study groups; on delete, show the message and keep the group. |
| `deals_schema_missing` | 503 | `/api/deals*` | Campus Perks tables, or their `deleted_at` column, are missing. | "Coming soon" for perks. |
| `marketplace_schema_missing` | 503 | `/api/marketplace*` (not `/api/marketplace/capabilities`, see below), `/api/admin/hidden/marketplace*`, `/api/admin/photo-review*` | Marketplace tables, their `deleted_at` column, or the gallery and pricing columns (`image_urls`, `price_mode`) are missing. The photo review columns answer `photo_review_schema_missing` instead (next row). | "Coming soon" for the marketplace. |
| `photo_review_schema_missing` | 503 | `/api/admin/photo-review*`; `POST /api/marketplace` and `PATCH /api/marketplace/:id` only while `MARKETPLACE_PHOTO_REVIEW` is on and the write adds a photo | The photo review columns on `marketplace_listings` (`photos_review`, `photos_reviewed_at`, `photos_reviewed_by`) are missing: README step 46, `db/supabase-marketplace-photo-review.sql`, has not run (issue #504, see [moderation.md](moderation.md#photo-review)). No marketplace read needs them: without them every listing reads as approved, and `/api/admin/overview` sends `pendingPhotos: null`. | The admin Photo review page shows the message. A student posting or editing photos sees the message and keeps the draft; a listing without photos still posts. |
| `friends_schema_missing` | 503 | `/api/me/profile-card`, `/api/me/matches`, `/api/connections*`, `/api/me/connections` | Friend matching tables are missing. | "Coming soon" for friend matching. |
| `content_reports_schema_missing` | 503 | `POST /api/reports` (not for a marketplace listing, which is still counted through `marketplace_reports`), `/api/admin/reports*` | `content_reports` is missing: README step 38, `db/supabase-report-and-block.sql`, has not run (see [moderation.md](moderation.md)). | Tell the student reporting is not available yet; the admin queue shows the message. |
| `blocked_users_schema_missing` | 503 | `/api/me/blocks*` | `blocked_users` is missing: README step 38, `db/supabase-report-and-block.sql`, has not run (see [moderation.md](moderation.md)). The lists that hide blocked users keep working and hide nobody. | Tell the student blocking is not available yet. |
| `advertiser_schema_missing` | 503 | `/api/advertiser/*`, and the portal admin routes `/api/admin/leads*`, `/api/admin/campaigns*`, `/api/admin/advertisers` | Advertiser portal tables (portal, campaigns or password resets) are missing. Count-only reads cannot see a missing table: `/api/admin/overview` and the impression and tap counts of `/api/advertiser/campaigns/:id/stats` answer `200` with zeros instead. | Show the portal as unavailable. |
| `moderation_schema_missing` | 503 | `/api/admin/deleted/:type*`, `/api/admin/content/:type/:id` | That content type has no `deleted_at` column yet: `db/supabase-study-groups-soft-delete.sql` for `study-groups`, `db/supabase-soft-delete.sql` for every other type. | Admin view: show the message for that type. Retrying does not help until the migration runs; the message does not name the file (see below). |
| `push_not_configured` | 503 | `/api/push/*`, `/api/me/push-token` | Push tables are missing (`db/supabase-push.sql`), or on `/api/me/push-token` the `push_devices` table is (`db/supabase-push-devices.sql`, issue #194). The message still names the file. `GET /api/push/settings` does not answer it for a missing `push_devices`: it lists no devices instead. | Show notifications as not set up (the website Settings card does). |
| `push_disabled` | 503 | `/api/push/*`, `POST /api/me/push-token` | The server has no VAPID keys. They switch off the native app's push too. | Treat push as switched off. |
| `purdue_email_verification_schema_missing` | 503 | `/api/me/purdue-email/*` | `purdue_email_challenges` is missing: README step 39, `db/supabase-purdue-email-verification.sql`, has not run (see [purdue-email-verification.md](purdue-email-verification.md)). Linking through CAS or the mock is unaffected. | Show email verification as not available yet. |
| `purdue_linking_disabled` | 400 | `POST /api/purdue/link-token` | `PURDUE_AUTH_MODE=off`. | Hide the Purdue link option. See [purdue-link.md](purdue-link.md). |
| `purdue_link_unconfigured` | 503 | `POST /api/purdue/link-token` | `SESSION_SECRET` is shorter than 32 characters. | Show linking as unavailable. |
| `sign_in_codes_schema_missing` | 503 | `POST /api/auth/sign-in`, `POST /api/auth/register-supabase`, `POST /api/auth/sign-in/verify`, `POST /api/auth/sign-in/resend` | `LOGIN_TWO_FACTOR` is on but `sign_in_challenges` is missing: README step 41, `db/supabase-sign-in-challenges.sql`, has not run. A sign-up answering it has already created the account. | Show the message; email + password sign-in waits on the migration, Google sign-in is unaffected. |
| `purdue_link_unauthorized` | 401 | `POST /api/purdue/link-token` | The session has no valid student id. | Send the student to sign in again. |
| `dining_bad_food` | 400 | `GET /api/dining/foods/:id` | The id is not a Nutrislice food id (digits only). | A client bug: the ids come from the `/api/dining` snapshot. |
| `dining_bad_date` | 400 | `GET /api/dining/foods/:id` | `?date=` is not a real date from yesterday to today + 14 on the Indianapolis calendar. | Use the snapshot's `date`. |
| `dining_food_not_found` | 404 | `GET /api/dining/foods/:id` | The dish is not on any of that date's menus (issue #468). | Show what the snapshot item already has; the menu may have changed since it loaded. |
| `dining_internal` | 500 | `GET /api/dining/foods/:id`, `GET /api/dining/upcoming` | The lookup failed (logged as `Nutrislice dish error:` or `Nutrislice upcoming error:`). | Show what is already loaded and offer a retry. |
| `dining_alerts_schema_missing` | 503 | `PUT /api/push/settings` with `diningFavoriteAlerts` | The favorite dish alerts column is missing: README step 42, `db/supabase-dining-favorite-alerts.sql`, has not run (issue #469). `GET /api/push/settings` says so with `diningAlertsAvailable: false`. | Keep the switch disabled; the other settings save as before. |
| `campus_events_schema_missing` | 503 | `POST /api/internal/campus-events/ingest` (a run, not a dry run), `GET /api/campus-events/free-food` | `campus_events` is missing: README step 43, `db/supabase-campus-events.sql`, has not run (issue #30, see [campus-events-ingest.md](campus-events-ingest.md)). The dry run works without it. | The ingest cron: run the migration; the next run writes the rows. The signed-out Free Food page (issue #366) shows its load failure with a retry, as for any failed read. |
| `club_follows_schema_missing` | 503 | `GET /api/me/club-follows`, `PUT` and `DELETE /api/me/club-follows/:organizationKey` | `club_follows` is missing: README step 48, `db/supabase-club-follows.sql`, has not run (issue #16, see [clubs.md](clubs.md#following-a-club)). The Events and Free Food reads keep working and mark no row as followed. | Hide or disable following ("coming soon"); do not retry in a loop. |
| `club_follows_bad_key` | 400 | `PUT` and `DELETE /api/me/club-follows/:organizationKey` | The key is not `boilerlink:<Id>` or `thespot:<Id>` with a positive integer Id. | A client bug: build the key as `boilerlink:` and the club's `id` from `GET /api/clubs`, or take a row's `organizationKey`. |
| `club_follows_unknown_club` | 404 | `PUT /api/me/club-follows/:organizationKey` | The club directory does not list that club: it left BoilerLink, or it is a TheSpot club, which has no directory and cannot be followed yet. Unfollowing never answers it. | Show the message and refresh the club list. |
| `club_follows_limit` | 409 | `PUT /api/me/club-follows/:organizationKey` | The student already follows 100 clubs (`MAX_CLUB_FOLLOWS`). Following one already followed still answers 200. | Show the message; the student unfollows one first. |
| `club_follows_directory_unavailable` | 503 | `PUT /api/me/club-follows/:organizationKey` | BoilerLink has not answered since the server started, so a new follow cannot be checked. Not a `_schema_missing` code: following works again once the directory loads, usually within minutes. | Show the message and let the student try again later. |

Every `*_schema_missing` code ends in `_schema_missing`, so a client can match
the suffix instead of listing features: the mobile app maps `503` plus that
suffix to its "coming soon" state.

## Schema-missing answers (issue #218)

`src/dbErrors.mjs` owns these responses. `DB_FEATURES` lists each feature's
key (the code prefix), the subject of the client message, the SQL file(s) that
create its tables, and the 500 fallback message. The per-feature route helpers
(`respondMarketplaceDbError` in `src/marketplaceDb.mjs`, and the rest, such as
`respondBoardDbError`, in the feature routers under `src/routes/`) are thin
wrappers over `respondDbError`.

- A missing table or column answers `503` with the feature's code and the
  message `<Feature> is not set up yet. Please try again later.` That is
  PostgREST `PGRST205` or `PGRST204`, Postgres `42P01` or `42703`, or, for an
  error without one of those codes, a "schema cache", "Could not find the table"
  or "relation/column ... does not exist" message.
- A missing function, operator or type (Postgres `42883` or `42704`, such as
  `operator does not exist: uuid = text`, or PostgREST `PGRST202`) is a bug in
  the query, not a migration that has not run, so it takes the `500` path below.
- The SQL file to run is logged instead of sent, once per feature, file and
  database error (code and message) per server process, so Render logs and
  Sentry get it once rather than on every request, and a new cause (a missing
  column after a missing table, or a second missing column) still gets its own
  line. Look for a line like
  `[marketplace] schema missing: run db/supabase-marketplace.sql in the Supabase SQL Editor, then retry.`
  followed by the database error code and message. Restarting the server logs it
  again on the next hit.
- For the board, guide, deals and marketplace, a missing `deleted_at` column
  still answers that feature's code, but the log names
  `db/supabase-soft-delete.sql`, the migration that adds it. Study groups do the
  same with `db/supabase-study-groups-soft-delete.sql`, and a missing marketplace
  `image_urls` or `price_mode` column names
  `db/supabase-marketplace-gallery-pricing.sql`. A missing photo review column
  (`photos_review`, `photos_reviewed_at`, `photos_reviewed_by`) answers its own
  code, `photo_review_schema_missing`, and names
  `db/supabase-marketplace-photo-review.sql`.
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

`respondRouteError` (issue #206) is the responder for a route with no
`DB_FEATURES` entry: `404` `Not found.` for a missing row or a malformed id,
otherwise `500` with the route's own fixed message, never the database text.
The manual task, grade and dining favorite writes use it (`src/routes/me.mjs`,
`src/routes/dining.mjs`), and so do `GET /api/me/calendar` and
`GET /api/me/tasks/meta`. The account and calendar-source routes under
[Older error shapes](#older-error-shapes) do not use it yet.

## 503s without a code

These are temporary or configuration states that are not tied to a missing
table. Show the message and let the student retry later.

- `POST /api/auth/sign-in`: Supabase Auth is unreachable.
- `POST /api/board/ai-suggestions`: no Groq key on the server.
- `GET /api/transit/*`: transit is not configured.
- `GET /api/marketplace/capabilities`: the gallery and pricing columns are not
  there yet; both clients hold off on galleries and price choices.
- Marketplace photo routes: photo storage is unavailable or not configured.
- `POST /api/me/purdue-email/request`: the verification code could not be
  mailed (Resend failed, or email is not configured in production). Nothing
  is pending afterwards, so the student can ask again at once.

## Older error shapes

These routes predate the envelope rules above. Until they move over, a client
must not assume `error` is an object or that its `message` is safe to show.

- `push_not_configured`: the message names `db/supabase-push.sql`, or
  `db/supabase-push-devices.sql` on `/api/me/push-token`.
- Several account and calendar-source routes (`src/routes/auth.mjs`,
  `src/routes/sources.mjs`) pass the underlying error's message through.
- `POST /api/me/tasks/calendar/complete` answers an unknown calendar item with
  `404 { error: { message } }` and no `status`.
- `POST /api/assistant`, `GET /api/parking/garages` and `GET /api/clubs` answer
  `{ error: "<text>" }`.
- `GET /api/dining` answers `{ ok: false, error: "dining_bad_date" | "dining_internal", locations: [] }`
  (see [dining.md](dining.md)). Its dish details read uses the envelope (see Codes).
- The cron routes `POST /api/internal/push/run-reminders` and
  `POST /api/internal/sources/resync` answer `{ ok: false, error: "<text>" }`.

## Website client

`authRequest` (`boilerindy-react/src/lib/authApi.ts`) throws an `Error` with
`status`, the raw `payload`, and `code` copied from `payload.error.code` when it
is a string, so a page can check `error.code?.endsWith('_schema_missing')`.
