-- #528: the retention deletes the Privacy policy promises, run by pg_cron
-- instead of by hand.
--
-- The Privacy page says raw usage analytics are kept at most 12 months, and
-- docs/analytics.md and docs/push-notifications.md asked the owner to run the
-- deletes in the SQL Editor every so often. A promise that only holds while
-- someone remembers a query will eventually be broken, so three jobs do it from
-- inside the database:
--
--   boilerindy-retention-analytics        daily, analytics_events older than 12 months
--   boilerindy-retention-push-deliveries  weekly, push_deliveries older than 60 days
--   boilerindy-retention-sessions         daily, user_sessions past their expiry
--
-- Plain SQL: no HTTP call, no secret, nothing for the server to do. Needs the
-- pg_cron extension from db/supabase-keep-warm.sql (README step 29) and the
-- tables from steps 4, 11 and 30. Creates no tables.
--
-- Paste the whole file into the Supabase SQL Editor once. Safe to run more
-- than once: cron.schedule() with an existing job name updates that job in
-- place instead of adding a second one. A job whose table does not exist yet
-- only fails its own run, and starts working once that table's step has run.
--
-- Verify:
--   select jobname, schedule, active from cron.job
--     where jobname like 'boilerindy-retention-%' order by jobname;
--   select j.jobname, d.status, d.return_message, d.start_time
--     from cron.job_run_details d join cron.job j using (jobid)
--     where j.jobname like 'boilerindy-retention-%'
--     order by d.start_time desc limit 10;
-- Expect three active jobs and "succeeded" runs; return_message says how many
-- rows each DELETE removed ("DELETE 0" on a quiet day).
--
-- Remove one (the others keep running):
--   select cron.unschedule('boilerindy-retention-analytics');

select cron.schedule(
  'boilerindy-retention-analytics',
  '0 4 * * *', -- 04:00 UTC every day
  $$DELETE FROM analytics_events WHERE created_at < NOW() - INTERVAL '12 months'$$
);

select cron.schedule(
  'boilerindy-retention-push-deliveries',
  '15 4 * * 0', -- 04:15 UTC every Sunday
  $$DELETE FROM push_deliveries WHERE sent_at < NOW() - INTERVAL '60 days'$$
);

select cron.schedule(
  'boilerindy-retention-sessions',
  '30 4 * * *', -- 04:30 UTC every day
  $$DELETE FROM user_sessions WHERE expire < NOW()$$
);
