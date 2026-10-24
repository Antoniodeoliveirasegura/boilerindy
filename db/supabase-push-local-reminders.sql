-- Local reminders on a phone (Antoniodeoliveirasegura/boilerindy-app#55): one
-- flag per registered phone in push_devices. The native app schedules the
-- student's class and task reminders on the phone itself. A phone that also
-- registers its Expo push token, for the alerts it cannot know ahead of time
-- (the favorite-dish alerts now, more later), would otherwise get every
-- deadline reminder twice: once from the phone and once from the reminder run.
--
-- The app sends localReminders: true with POST /api/me/push-token while its
-- reminders are on, and every registration replaces the flag. The reminder
-- run (POST /api/internal/push/run-reminders) then sends that phone no
-- deadline reminders, while the student's browsers and other phones still get
-- them. The favorite-dish alerts and the Settings test send ignore the flag.
-- Off by default, so every phone registered before this keeps its server
-- reminders.
--
-- Needs db/supabase-push-devices.sql (README step 40), whose table it extends.
-- Idempotent and safe to rerun. Existing rows read false, and no row is
-- rewritten: Postgres 11 and later store a constant default once, in the
-- catalog. Until it runs nothing breaks: phones still register, without the
-- flag, and the server log names this file once; GET /api/push/settings lists
-- every phone with localReminders false; and the reminder run sends deadline
-- reminders to every phone, as before. See docs/push-notifications.md.

ALTER TABLE push_devices
  ADD COLUMN IF NOT EXISTS local_reminders BOOLEAN NOT NULL DEFAULT FALSE;

NOTIFY pgrst, 'reload schema';
