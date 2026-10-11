-- Run in Supabase SQL Editor (once). Native push for the Expo app (issue
-- #194): one row per phone that registered an Expo push token at
-- POST /api/me/push-token. Browsers stay in push_subscriptions; the settings
-- and the once-per-item ledger in db/supabase-push.sql (README step 30) are
-- shared, so run this after that one. To apply it needs only users from
-- db/supabase-schema.sql. Idempotent - safe to re-run.
--
-- `token` is the ExponentPushToken[...] string and is unique: when a phone
-- signs in to another account, registering again moves the row to that
-- student. Like a Web Push endpoint it is a capability (anyone holding it can
-- notify the phone through Expo), so RLS is enabled with no policies, as for
-- every table in db/ (test/rlsCoverage.test.mjs), and the API never returns it.
--
-- failure_count holds the strikes from deliveries Expo refused for a reason
-- that points at the device. A success clears it; at 5 the next reminder run
-- deletes the row. DeviceNotRegistered deletes the row at once.
--
-- Until this runs, /api/me/push-token answers 503 push_not_configured and
-- Web Push carries on unchanged: the settings read, the test send and the
-- reminder runner treat the missing table as no phones.

CREATE TABLE IF NOT EXISTS push_devices (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'expo' CHECK (kind IN ('expo')),
  token         TEXT NOT NULL UNIQUE CHECK (char_length(token) <= 200),
  platform      TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  device_name   TEXT CHECK (device_name IS NULL OR char_length(device_name) <= 120),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0)
);

-- Every read filters on user_id, and so does the cascade when a student
-- deletes their account.
CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);

-- The server uses the service-role key (bypasses RLS). No policies: the Data
-- API roles get nothing.
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
