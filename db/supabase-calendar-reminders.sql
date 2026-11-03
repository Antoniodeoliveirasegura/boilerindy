-- Calendar reminders switch: users.calendar_reminders_off, false by default
-- (Antoniodeoliveirasegura/boilerindy-app#150). While it is false, a student
-- with no calendar connected is reminded after signing in: the website opens
-- Setup and Home shows its Finish Setup card. "Don't ask again" on the
-- website's Setup and the "Remind me to connect calendars" switch in Settings
-- set it, and the app's sign-in reminder reads the same flag, so a choice made
-- on one device holds on every other. Before this column, "Don't ask again"
-- was kept only in that browser (localStorage pih-skip-setup).
--
-- PATCH /api/me/profile sets it from { calendarRemindersOff }, and the session
-- payload carries it as user.calendarRemindersOff, beside aiOptIn from step 52.
--
-- Until this runs nothing breaks: every account reads reminders on, the
-- website keeps a "Don't ask again" in that browser as it did before, and
-- turning reminders off answers 503 calendar_reminders_schema_missing.
--
-- Idempotent and safe to re-run. Existing accounts read false; no row is written.

ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_reminders_off BOOLEAN NOT NULL DEFAULT FALSE;
