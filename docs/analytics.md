# First-Party Product Analytics (issue #51)

Privacy-conscious usage analytics stored in our own Supabase. **No third-party
trackers** — there is no Google Analytics, no pixel, no external script. Events
power feature prioritization (e.g. consolidating the marketplace issues) and the
accurate data disclosure required for app-store listing (issue #26).

## How it works

| Piece | Where | What it does |
|---|---|---|
| `db/supabase-analytics.sql` | `db/` | Creates `analytics_events` (RLS, service-role only) and `users.analytics_opt_out`. Run once in the Supabase SQL Editor. |
| `src/analytics.mjs` | `src/` | Pure validation: event-name allowlist, batch cap (20), page/props size caps. Unit-tested in `test/analytics.test.mjs`. |
| `POST /api/analytics/events` | server.mjs | `requireAuth` + rate-limited. Re-checks the opt-out server-side, then inserts the batch with the service-role client. Accepts `text/plain` so `sendBeacon` flushes parse too. Fail-soft (202) if the table is missing. |
| `src/lib/analytics.js` | frontend | `track(eventName, props)` queue; flushes every 10s, at 20 queued events, and on `pagehide` via `navigator.sendBeacon`. Disabled (and queue dropped) when signed out or opted out. |
| `AnalyticsListener.jsx` | frontend | Enables tracking only for signed-in, non-opted-out users; records `page_view` on every route change. |
| Settings → Privacy | frontend | Opt-out toggle (writes `analyticsOptOut` via `PATCH /api/me/profile`) + link to `/privacy`. |

## Event allowlist

Only these names are accepted (`ANALYTICS_EVENTS` in `analytics.mjs`); anything
else is rejected with a 400. Add new events to the constant **and** this table.

| Event | Fired when |
|---|---|
| `page_view` | Any route change (path in props) |
| `source_synced` | A calendar source is connected or re-synced |
| `board_post_created` | A board post is published |
| `assistant_message_sent` | A campus-assistant message is sent (event only — never the text) |
| `dining_viewed` | Dining page opened |
| `transit_viewed` | Transit page opened |
| `task_completed` | A task is marked complete |

## Privacy guarantees

- Signed-in users only; `user_id` references `users(id)` **ON DELETE CASCADE**,
  so deleting an account deletes its analytics rows.
- Opt-out (Settings → Privacy) takes effect immediately: the client drops its
  queue and stops sending, and the server independently refuses to store events
  for opted-out users.
- RLS with no policies: only the service-role key (the Node server) can touch
  the table; the browser's anon key sees nothing.
- No free-form content is ever recorded — no message text, post bodies,
  schedule contents, grades, or location.

## Retention: 12 months

Raw events are deleted after 12 months. Until a Supabase scheduled query (cron)
is configured, run this manually about once a month in the SQL Editor:

```sql
DELETE FROM analytics_events WHERE created_at < NOW() - INTERVAL '12 months';
```

With `pg_cron` enabled it can be scheduled instead:

```sql
SELECT cron.schedule(
  'analytics-retention',
  '0 4 1 * *', -- 04:00 on the 1st of every month
  $$DELETE FROM analytics_events WHERE created_at < NOW() - INTERVAL '12 months'$$
);
```

## HUMAN CHECKPOINT before production

Per issue #51, tracking must not ship to prod until the owner reviews and
approves:

1. The draft privacy page at `/privacy` (`src/pages/Privacy.jsx`).
2. The one-line disclosure on the signup form (`Login.jsx`).

After approval: run `db/supabase-analytics.sql` in production Supabase, deploy,
and update the "Last updated" date on the privacy page.
