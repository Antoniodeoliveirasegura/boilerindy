-- Run in Supabase SQL Editor (once). Two-step sign-in codes: after an email +
-- password sign-in or sign-up checks out, the student types a six-digit code
-- mailed to the account before the session holds a user (src/twoFactor.mjs,
-- src/routes/auth.mjs). Needs db/supabase-schema.sql (users) and nothing
-- else. Idempotent - safe to re-run.
--
-- One row per pending sign-in, and the session holds only its id. Only an HMAC
-- of the current code is stored, keyed by the server's SESSION_SECRET and
-- bound to the row id and the user, so a leaked row cannot be replayed. The
-- counters live here rather than in the session because a session is a copy
-- per request: the server counts each guess with a compare-and-swap on
-- `attempts` before it compares the code, so five guesses stay five under
-- parallel requests, and it spends a right code by deleting the row, which
-- only one request can do. A new sign-in deletes the student's earlier rows, so
-- each student has one pending sign-in at most and no row outlives it for long.

CREATE TABLE IF NOT EXISTS sign_in_challenges (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sends       INTEGER NOT NULL DEFAULT 1,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A new sign-in deletes by user_id, and the account-deletion cascade needs it.
CREATE INDEX IF NOT EXISTS sign_in_challenges_user_idx
  ON sign_in_challenges (user_id);

-- The server uses the service-role key (bypasses RLS) and enforces every rule
-- in code, like the other student tables. No policies: the Data API roles get
-- nothing.
ALTER TABLE sign_in_challenges ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
