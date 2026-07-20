-- #111: persistent server sessions, so a restart stops logging everyone out.
--
-- express-session defaults to an in-process MemoryStore. Render's free tier
-- spins the service down after ~15 min idle, which wiped every session: a
-- returning user with a perfectly valid 14-day cookie was bounced to /login and
-- paid a full re-login on top of the cold start. src/sessionStore.mjs keeps
-- sessions here instead.
--
-- Rows are opaque to the rest of the schema on purpose. `sess` holds whatever
-- express-session serialises - today { cookie, userId } for students and
-- { cookie, advertiserId } for the advertiser portal - so there is deliberately
-- no foreign key to users(id): one table serves both audiences, and a session
-- row outliving its user is handled by the app rejecting an unknown id.
--
-- Until this runs, createSessionStore() logs a warning and the app falls back to
-- in-memory sessions, i.e. exactly the old behaviour. Nothing breaks; the fix
-- simply is not active.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS user_sessions (
  sid    TEXT PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);

-- Supports the expired-row sweep below. The read path is a primary-key lookup
-- on `sid` and needs no index of its own.
CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);

-- Sessions are read and written only by the Node server, which uses
-- SUPABASE_SERVICE_ROLE_KEY and bypasses RLS. Enabled with no policies so the
-- public anon key cannot touch session rows over the Data API. See the RLS note
-- in db/supabase-schema.sql; test/rlsCoverage.test.mjs enforces this.
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;

-- Reclaim expired rows. The store also deletes expired rows lazily when one is
-- read, so this is only needed for sessions that are never revisited. Re-run it
-- whenever, or attach it to a scheduled job if the table ever grows enough to
-- matter.
DELETE FROM user_sessions WHERE expire < NOW();
