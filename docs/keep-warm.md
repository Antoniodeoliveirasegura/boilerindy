# Keeping the API warm

The backend runs on Render's free tier, which spins the instance down after
about 15 minutes without a request and boots it again on the next one
(issue #164, following #111). Measured on 2026-09-06 against
`https://boilerindy-api.onrender.com/api/health`:

- first request after an idle spell: 21.6 s (Render quotes up to ~50 s)
- warm request: 0.29 s

Every first page load pays that wait, because `AuthContext` calls
`/api/session` on boot and every API call is a relative `/api/...` URL that
Vercel rewrites to Render. Until the instance answers, the app looks hung.

## Why the GitHub cron was not enough

`.github/workflows/keep-warm.yml` has pinged `/api/health` on a schedule since
#111. GitHub runs scheduled workflows on a best-effort basis and throttles
them: on the `*/10 * * * *` schedule it ran 12 times in 31 hours, with gaps of
1.75 to 4.5 hours between runs. Any gap over 15 minutes lets the instance
sleep, so most visits still hit a cold start.

## The three layers

1. **Supabase pg_cron job - primary.** `db/supabase-keep-warm.sql` schedules
   `boilerindy-keep-warm`, a `pg_cron` job that uses `pg_net` to `GET
   /api/health` every 5 minutes from inside the Postgres database. The
   database never sleeps and pg_cron is not throttled, so the instance stays
   up. It creates no tables and touches nothing in the public schema.
2. **GitHub workflow - backstop.** The schedule is now `2-59/5 * * * *`:
   every 5 minutes, offset from the top of the hour because GitHub documents
   that on-the-hour jobs are the first to be delayed. It only runs from `main`
   and is still throttled, so treat it as insurance for when the database job
   is paused, not as the fix.
3. **Frontend notice - UX.** `ServerWakeNotice` (mounted in `App.tsx`) fires
   one `GET /api/health` per page load through
   `boilerindy-react/src/lib/serverWarmup.ts` and, if the answer takes more
   than 2.5 s, shows a "Waking up the server" pill until the server responds.
   Any HTTP status counts as awake; a network error or a 90 s timeout hides
   the pill and leaves the page's normal error handling in charge. This does
   not shorten the cold start, it only stops it from looking like a broken
   site.

## One-time setup (owner)

1. Open the Supabase dashboard for the live project, go to SQL Editor, paste
   the whole of `db/supabase-keep-warm.sql` and run it. It enables `pg_cron`
   and `pg_net` if they are not on yet and schedules the job. Safe to re-run:
   scheduling under an existing job name updates that job in place.
2. If the API ever moves, edit the `url` in the file and run it again.

No-SQL alternative: an [UptimeRobot](https://uptimerobot.com) HTTP monitor on
`https://boilerindy-api.onrender.com/api/health` with a 5-minute interval does
the same job from outside, and the free plan allows that interval. Pick one
pinger, not both: two do no harm, but they make it harder to tell which one is
actually keeping the instance up.

## Verifying

At any hour of the day the health probe should answer in well under a second:

    curl -o /dev/null -s -w '%{time_total}\n' https://boilerindy-api.onrender.com/api/health

A cold start shows up as 20 s or more. In the Supabase SQL Editor:

    select jobid, jobname, schedule, active from cron.job;
    select status, return_message, start_time from cron.job_run_details
      order by start_time desc limit 10;

Expect one `boilerindy-keep-warm` row and a `succeeded` run every 5 minutes.
`return_message` reports that pg_net queued the request (`1 row`), not the HTTP
status; the responses themselves sit in `net._http_response` for a few hours:

    select status_code, created from net._http_response order by created desc limit 5;

The GitHub side is under Actions -> Keep backend warm. Gaps between runs there
are expected, and are exactly why the database job exists.

## Removing it

    select cron.unschedule('boilerindy-keep-warm');

Then delete the workflow, or just its `schedule` block, if the backstop is not
wanted either. The frontend notice needs no configuration and is harmless when
the server is always warm: it never renders unless a request is slow.
