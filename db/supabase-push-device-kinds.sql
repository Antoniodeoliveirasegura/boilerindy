-- What each phone can take (issue #550, item 4): the facts a phone reports
-- when it registers its Expo push token at POST /api/me/push-token, so no
-- kind of notification reaches it from two senders and none goes to a channel
-- it lacks. push_devices gains:
--
--   kinds                 the server kinds the phone shows (kind ids from
--                         src/notificationKinds.mjs), never one it schedules
--                         itself; NULL for an app build from before kinds
--   channels              the Android channels the build created; a message
--                         names its kind's channel only when it is listed
--   kinds_version         the version of the kind registry the build carries
--   redact                the app lock is on: copy shows times and counts only
--   activity_start_token  the Live Activity push-to-start token (iOS 17.2 and
--                         later), kept for later and never returned
--
-- A phone with kinds gets a server push only for a kind it listed (the test
-- send excepted). A row with NULL kinds, from an older build, follows the
-- local_reminders rule of README step 47 as before.
--
-- Needs db/supabase-push-devices.sql (README step 40) and
-- db/supabase-push-local-reminders.sql (step 47). Idempotent and safe to
-- rerun; existing rows read NULL kinds, channels and version, and redact
-- false. Until it runs nothing breaks: phones register without these facts,
-- the server log names this file once, and every phone is treated as an
-- older build. See docs/push-notifications.md.

ALTER TABLE push_devices
  ADD COLUMN IF NOT EXISTS kinds TEXT[],
  ADD COLUMN IF NOT EXISTS channels TEXT[],
  ADD COLUMN IF NOT EXISTS kinds_version SMALLINT,
  ADD COLUMN IF NOT EXISTS redact BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS activity_start_token TEXT;

NOTIFY pgrst, 'reload schema';
