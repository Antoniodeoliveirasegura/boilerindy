# Background calendar re-sync

Issue #12. A student connects a Brightspace or Purdue Timetabling feed once;
before this, the imported classes and due dates only changed when they
pressed Sync or "Sync all" on the Connect page, so a due date moved in
Brightspace stayed stale here. Now a cron job re-imports every feed on a
schedule.

## How it works

- `POST /api/internal/sources/resync` (server.mjs), bearer-authenticated with
  `PUSH_CRON_SECRET`, the same token as the reminder runner. With the secret
  unset the route does not exist.
- `src/sourceResync.mjs` lists up to 200 `linked_sources` rows in `ready`,
  `pending` or `error` status, oldest sync first, and picks the ones that are
  due:
  - `ready` / `pending`: never synced, or last synced more than 6 hours ago;
  - `error`: last attempt more than 24 hours ago, so an expired link is
    retried daily instead of every tick (the student can still press Sync).
- At most 15 sources per tick, synced one at a time with the same
  `runScheduleSync` the manual buttons use (SSRF-safe fetch, host allowlist,
  atomic replace of the items). A sync that fails marks its source `error`
  with the classified message and the tick moves on. After 60 seconds no new
  sync is started; the rest are reported as `deferred` and picked up next hour.
- A tick already in flight answers `409 resync_in_progress`.

The JSON summary looks like:

```json
{ "ok": true, "scanned": 42, "truncated": false, "due": 9, "synced": 8, "failed": 1, "deferred": 0, "items": 311,
  "failures": [{ "id": "...", "message": "Calendar access denied. The feed URL may have expired - try generating a new one." }],
  "durationMs": 8123 }
```

## Scheduling

`db/supabase-source-resync.sql` holds the `pg_cron` + `pg_net` snippet
(hourly, minute 17). It needs the extensions from `db/supabase-keep-warm.sql`
and `PUSH_CRON_SECRET` set on Render. To run a tick by hand:

```bash
curl -sS -X POST -H "Authorization: Bearer $PUSH_CRON_SECRET" https://boilerindy-api.onrender.com/api/internal/sources/resync
```

## What the student sees

A feed that stops syncing (expired link, deleted calendar) used to show only
as a status badge on the Connect page. `SourceErrorNotice` now renders on the
dashboard and on Assignments with the source name, the sync error and a link
back to Calendar sources.

## Tuning

Defaults live at the top of `src/sourceResync.mjs` (`DEFAULT_STALE_MS`,
`DEFAULT_ERROR_RETRY_MS`, `DEFAULT_BATCH`, `DEFAULT_BUDGET_MS`). With more
than about 90 active sources (15 per hour, 6-hour staleness) the batch or the
cron frequency needs to go up; `truncated: true` in the summary means more
than 200 candidates were listed and the cap should rise too.
