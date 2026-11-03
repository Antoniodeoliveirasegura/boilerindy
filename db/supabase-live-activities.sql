-- Track this bus (issue #550, "Later"; boilerindy-app#173, item 5): the Live
-- Activity's server half. The app starts a Live Activity on the Lock Screen
-- and in the Dynamic Island for a bus coming to a stop, and reports the
-- activity's APNs push token at POST /api/live-activities. The push fast
-- tick (POST /api/internal/push/fast-tick, which the pg_cron job in
-- db/supabase-push-fast-tick.sql calls) reads the stop's arrivals through the
-- widgets' 15-second cache and sends each open activity its updates straight
-- to Apple's push service. See src/liveActivities.mjs, src/apnsLiveActivity.mjs
-- and docs/push-notifications.md.
--
-- live_activities: one row per activity, keyed by the id ActivityKit gave it,
-- which only the phone knows.
-- - user_id is NULL for an activity started signed out, which is allowed
--   (decision 4 of the notifications build): the routes' address limits and
--   the 30-minute life bound it.
-- - push_token is the activity's APNs token, never returned or logged, and
--   apns_env the APNs host that takes it.
-- - stop_key is a place key of GET /api/transit/places; route_id the route it
--   follows, or NULL for the next bus of any route there.
-- - ends_at is 30 minutes after the start, when the tick ends the activity if
--   nothing ended it first; ended_at marks it over: the bus came, the 30
--   minutes ran out, service ended, the student ended it, or APNs said the
--   token is gone.
-- - last_state and last_pushed_at are what the phone was last sent and when.
--   The tick claims each push by changing last_state from the value it read,
--   so overlapping ticks, or a second instance during a deploy, never send
--   twice.
--
-- The retention job in db/supabase-retention.sql (README step 51) deletes each
-- row a day after its 30 minutes end; re-run that file after this one.
--
-- Needs db/supabase-schema.sql (README step 1) for users. Idempotent and safe
-- to rerun; it adds a table, so re-run db/supabase-anon-lockdown.sql (step 50)
-- afterwards. Until it runs nothing breaks: POST /api/live-activities answers
-- 503 live_activities_schema_missing, the tick sends nothing and the server log
-- names this file once.

CREATE TABLE IF NOT EXISTS live_activities (
  activity_id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  push_token TEXT NOT NULL,
  apns_env TEXT NOT NULL CHECK (apns_env IN ('production', 'development')),
  stop_key TEXT NOT NULL,
  route_id INTEGER,
  ends_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  last_state TEXT,
  last_pushed_at TIMESTAMPTZ
);

-- The tick reads the open activities; deleting an account removes its own.
CREATE INDEX IF NOT EXISTS idx_live_activities_open ON live_activities(ends_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_live_activities_user ON live_activities(user_id);

ALTER TABLE live_activities ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
