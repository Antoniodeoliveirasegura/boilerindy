-- Notifications by kind (issue #550, items 3 and 8): every choice a student
-- makes about notifications lives on the account, so the website's Settings
-- card and the native app show the same kinds. push_settings gains:
--
--   class_reminders, class_lead_minutes  the app's Classes kind, scheduled on
--                                        the phone: off, 15 minutes before
--   digest_minute                        the evening list of what is due, in
--                                        campus minutes past midnight: 6:00 PM
--                                        (1080); NULL is no list
--   deadline_items                       the optional reminder before each
--                                        item, lead_minutes ahead; existing
--                                        rows keep deadline_reminders here
--   quiet_start, quiet_end               quiet hours, campus minutes past
--                                        midnight: 11:00 PM to 8:00 AM; a NULL
--                                        pair is none
--   campus_alerts                        IU Indianapolis campus alerts: on
--   kinds_migrated_at                    when the first phone on an app build
--                                        with kinds filled in this account from
--                                        its old switches
--
-- deadline_reminders stays the switch for deadlines as a whole, and
-- lead_minutes the lead of the per-item reminder, so older app builds keep
-- working. Existing rows keep their per-item reminders and gain the 6:00 PM
-- list and quiet hours (owner decision 2 in the build plan).
--
-- The reminder run (POST /api/internal/push/run-reminders) then sends one
-- evening list per student a day instead of a pile of late reminders, holds
-- anything that falls in quiet hours to their end or drops it once it is past
-- due, reminds all-day items at 9:00 AM, and stops at 6 server pushes a day.
--
-- Needs db/supabase-push.sql (README step 30), whose table it extends.
-- Idempotent and safe to rerun. Until it runs nothing breaks: GET
-- /api/push/settings answers kindsAvailable false, a PUT of a new field
-- answers 503 push_kinds_schema_missing, and the reminder run works as before
-- (per-item reminders only, no quiet hours, no cap). See
-- docs/push-notifications.md.

ALTER TABLE push_settings
  ADD COLUMN IF NOT EXISTS class_reminders BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS class_lead_minutes SMALLINT NOT NULL DEFAULT 15 CHECK (class_lead_minutes IN (5, 10, 15, 30)),
  ADD COLUMN IF NOT EXISTS digest_minute SMALLINT DEFAULT 1080 CHECK (digest_minute BETWEEN 0 AND 1439),
  ADD COLUMN IF NOT EXISTS deadline_items BOOLEAN,
  ADD COLUMN IF NOT EXISTS quiet_start SMALLINT DEFAULT 1380 CHECK (quiet_start BETWEEN 0 AND 1439),
  ADD COLUMN IF NOT EXISTS quiet_end SMALLINT DEFAULT 480 CHECK (quiet_end BETWEEN 0 AND 1439),
  ADD COLUMN IF NOT EXISTS campus_alerts BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS kinds_migrated_at TIMESTAMPTZ;

-- Existing rows keep their per-item reminders; new rows start without them.
UPDATE push_settings SET deadline_items = deadline_reminders WHERE deadline_items IS NULL;
ALTER TABLE push_settings
  ALTER COLUMN deadline_items SET DEFAULT FALSE,
  ALTER COLUMN deadline_items SET NOT NULL;

NOTIFY pgrst, 'reload schema';
