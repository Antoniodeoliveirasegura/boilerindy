-- #164: keep the Render API awake from inside the database, so the first
-- request of a quiet spell stops paying a cold start.
--
-- The API runs on Render's free tier, which spins the instance down after
-- ~15 min idle and boots it again on the next request. Measured 2026-09-06:
-- the first request after an idle spell took 21.6 s, a warm one 0.29 s. That
-- wait lands on GET /api/session, i.e. on every first page load, and the app
-- looks hung for the duration.
--
-- .github/workflows/keep-warm.yml was meant to prevent this, but GitHub
-- throttles scheduled workflows: on a 10-minute schedule it ran 12 times in
-- 31 hours, with gaps of 1.75 to 4.5 hours, so the instance slept most of the
-- day anyway. Supabase runs pg_cron inside Postgres, which never sleeps, and
-- pg_net lets a job make an HTTP request from there. Together they GET the
-- session-free /api/health every 5 minutes, well inside Render's idle window.
-- The GitHub workflow stays on as the backstop. See docs/keep-warm.md.
--
-- Paste the whole file into the Supabase SQL Editor once. Safe to run more
-- than once: cron.schedule() with an existing job name updates that job in
-- place instead of adding a second one. Nothing here touches the public
-- schema, so there is no table, no RLS and no server code involved; if the
-- job is ever removed the app keeps working, it just cold-starts again.
--
-- Verify after a few minutes (the same queries are repeated at the bottom):
--   select jobid, jobname, schedule, active from cron.job;
--   select status, return_message, start_time from cron.job_run_details
--     order by start_time desc limit 10;
-- Expect one row named boilerindy-keep-warm and a "succeeded" run every
-- 5 minutes. return_message reports that pg_net queued the request ("1 row"),
-- not the HTTP status; pg_net keeps the responses themselves for a few hours:
--   select status_code, created from net._http_response
--     order by created desc limit 5;
-- Or simply time the endpoint from a shell at any hour:
--   curl -o /dev/null -s -w '%{time_total}\n' https://boilerindy-api.onrender.com/api/health
--
-- Remove it:
--   select cron.unschedule('boilerindy-keep-warm');
--
-- If the API moves, edit the url below and run the file again.

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'boilerindy-keep-warm',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://boilerindy-api.onrender.com/api/health',
    timeout_milliseconds := 60000
  );
  $$
);

-- Check it is running:
--   select jobid, jobname, schedule, active from cron.job;
--   select status, return_message, start_time from cron.job_run_details
--     order by start_time desc limit 10;
-- Remove it:
--   select cron.unschedule('boilerindy-keep-warm');
