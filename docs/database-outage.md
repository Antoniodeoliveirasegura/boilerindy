# When the database cannot be reached

The API keeps all its state in one Supabase project (Postgres behind
PostgREST). When that project stops answering, every signed-in page and every
read that needs a table fails, while the Render service itself stays up. This
page is what happened on 2026-11-03, how to tell it is happening again, how to
recover, and what the API does in the meantime.

## 2026-11-03

All times UTC.

| When | What |
|---|---|
| 10:51:19 | Postgres logs its last line, the push fast tick finishing as usual, then nothing. No error or warning comes before it. |
| 11:12 | The first Cloudflare `522: Connection timed out` from Supabase in the Render log. |
| 11:15 | The project's last memory and CPU data point. |
| 12:41 | The 6-hourly campus events ingest, which Supabase's own `pg_cron` starts, fails: the Render log never sees it. |
| 13:50 to 14:22 | Students' requests fail: the app's Events tab sits on its loading rows, then says "Could not load events." Each request waits 20 to 60 s for Cloudflare's 522, and the server logs `[unhandled]` with the whole error page. |
| 14:22 | The owner restarts the project in the dashboard. |
| 14:23 to 14:33 | Cloudflare 525 and 521 while it boots, then PostgREST's `PGRST002` ("Could not query the database for the schema cache. Retrying.") for five minutes. |
| 14:33 | `GET /api/campus-events/free-food` answers 200 again. |

status.supabase.com stayed green throughout: the outage was this project, not
the platform. The dashboard showed the project as Unhealthy, with no CPU, disk
or RAM figures and "Conns Unavailable".

**Cause.** The project runs on the Free plan's Nano compute, 0.5 GB of memory
(411 MB usable). Observability > Database showed it at its limit for at least
the day before: RAM 98.8 to 98.9% used, swap 90 to 92% full, and memory
commitment (what the processes have reserved) at 1.31 to 1.33 GB of a 1.4 GB
capacity, which Supabase flags SEVERE, peaking at 1.48 GB at 04:15. At 10:51
the machine stopped answering, without Postgres ever reporting an error. One
minute after the restart, commitment was back at 1.4 GB: most of it is
Supabase's own stack on the same machine (Postgres, PostgREST, Auth, Realtime,
Storage, the log and metrics agents), reserved before BoilerIndy sends a query.

**What fixes it for good** is more memory. Compute sizes other than Nano need
the Pro plan; on 2026-11-03 that was $25 a month with a $10 compute credit
that covers one Micro instance (1 GB), and Pro adds the daily backups the Free
project does not have. Changing compute restarts the database for a few
minutes.

**What lightens it meanwhile**, done the same day with the owner's go-ahead:

- the `boilerindy-keep-warm` ping is unscheduled (README step 29): the push
  reminder run and the fast tick already call the API often enough to keep
  Render awake ([keep-warm.md](keep-warm.md));
- the fast tick runs every minute instead of every 30 seconds (README step 57,
  `db/supabase-push-fast-tick.sql`), half as many runs, and still inside the
  2-minute freshness the campus alert push allows IU's feed;
- the calendar re-sync takes 4 sources a run instead of 15, so the feeds that
  come due together spread over three hourly runs instead of landing at once
  ([source-resync.md](source-resync.md#tuning)).

Left as they were: the 5-minute reminder run (slower means late reminders),
the 6-hourly ingest (events count as stale after 26 hours, so a 12-hour
schedule would empty the board after two failed runs), and the nightly
retention jobs (small deletes, once a day).

## How to tell

- `curl -s https://boilerindy-api.onrender.com/api/health/db` answers 200
  `{"ok":true}` when the API can read the database, and 503 with code
  `database_unavailable` when it cannot. `GET /api/health` never touches the
  database and stays 200 through an outage; it is the keep-warm probe, not a
  health check of the database.
- The Render log has one line a minute while it lasts:
  `[database] unavailable (Supabase 522 Connection timed out) at GET /api/me: 14 request(s) answered 503 database_unavailable since the previous line`.
- Sentry has the issue `database: unavailable` (one fingerprint), with an event
  when the outage starts and one every 15 minutes while it lasts.
- The scheduled `Database health` workflow (`.github/workflows/db-health.yml`)
  fails; GitHub emails whoever last changed its schedule.
- In the Supabase dashboard the project reads Unhealthy, Observability >
  Database stops plotting, and Logs > Postgres goes quiet.

One thing that looks like a signal and is not: a key-less
`curl https://<ref>.supabase.co/rest/v1/` answers a fast 401 from Supabase's
edge gateway (`sb-gateway-version: 1`) even when the project is down.

## Recovering

1. In the Supabase dashboard, open the project, then Settings > General >
   Project availability > Restart project. On 2026-11-03 it took 11 minutes
   from the click to the first good answer: Cloudflare 525 and 521 while the
   machine booted, then `PGRST002` while PostgREST loaded its schema cache.
2. Watch `GET /api/health/db` until it answers 200. Nothing needs redeploying:
   the API answers 503 `database_unavailable` until then and recovers by
   itself.
3. Check Observability > Database: memory commitment near its capacity means
   the next freeze is a matter of time.
4. Scheduled jobs that fell inside the outage show as Failed on the cron page;
   each catches up on its next run (the re-sync hourly, the ingest at the next
   6-hour mark). Resolve the Sentry issue so the next outage alerts as a
   regression.

## What the API does meanwhile

`src/databaseUnavailable.mjs` recognises the failures that mean the database
cannot be reached at all: PostgREST's and Postgres's connection codes
(`PGRST000` to `PGRST003`, `53300`, `08xxx`, `57P01` to `57P03`), Supabase's
gateway statuses and Cloudflare's origin errors (502 to 504, 520 to 527, 530),
the error page or line a gateway sends in place of PostgREST's JSON, and a
Supabase fetch that never completed. Another service's outage (TransLoc, a
calendar feed host) is not one of them.

- Every route that needs the database answers 503
  `{ "error": { "message": "BoilerIndy cannot reach its database right now. Please try again in a few minutes.", "code": "database_unavailable", "status": 503 } }`
  with `Retry-After: 30` ([api-error-codes.md](api-error-codes.md)), through
  `respondDbError` and `respondRouteError` in `src/dbErrors.mjs`. A signed-in
  request whose session read fails gets the same answer from
  `createDatabaseOutageHandler`, which sits before Sentry's Express handler.
- `PGRST002` no longer reads as a missing table, so features answer
  `database_unavailable` instead of `*_schema_missing`, which the app shows as
  "coming soon", and the log no longer tells the operator to run SQL files.
- A boot while the database is down keeps the Postgres session store instead of
  falling back to memory for the life of the process (`src/sessionStore.mjs`).
- The log gets one line a minute instead of a page per request, and Sentry one
  event every 15 minutes, all in one issue, instead of one per request.

## Alerts

- **Sentry**: the first event of an outage opens (or reopens) the
  `database: unavailable` issue, which Sentry's issue alerts can email. It
  needs `SENTRY_DSN` on Render.
- **GitHub**: `Database health` checks `GET /api/health/db` every 15 minutes
  from `main`, three tries a minute apart. GitHub throttles scheduled
  workflows ([keep-warm.md](keep-warm.md) saw gaps of up to 4.5 hours), so it
  catches a long outage, not a short one.
- **An external monitor** is the reliable minute-level alarm, and needs an
  account the owner creates: for example an UptimeRobot HTTP(s) monitor on
  `https://boilerindy-api.onrender.com/api/health/db` every 5 minutes (the
  free plan's shortest), alerting when the answer is not 200. Every caller
  shares one database read every 10 seconds, so monitors cost the database
  nothing.
