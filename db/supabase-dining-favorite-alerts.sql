-- Favorite-dish alerts (issue #469): one opt-in switch per student on
-- push_settings. When it is on, the reminder run (POST
-- /api/internal/push/run-reminders, every 5 minutes) sends at most one push a
-- day, from 8:00 AM to 7:00 PM campus time, naming the student's favorite
-- dishes on that day's menu. Off by default, so nobody gets a new kind of
-- notification without turning it on in Settings.
--
-- Needs db/supabase-push.sql (README step 30), whose push_settings table it
-- extends and whose push_deliveries ledger the alerts claim, one row a day per
-- student ("dining-favorites:<YYYY-MM-DD>"). Idempotent and safe to rerun.
-- Until it runs nothing breaks: the Settings switch says the alerts are not
-- set up yet, turning it on answers 503 dining_alerts_schema_missing, and the
-- run skips the alerts. See docs/push-notifications.md.

ALTER TABLE push_settings
  ADD COLUMN IF NOT EXISTS dining_favorite_alerts BOOLEAN NOT NULL DEFAULT FALSE;
