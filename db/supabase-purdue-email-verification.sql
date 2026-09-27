-- Run in Supabase SQL Editor (once). Purdue email-code verification (issue
-- #181): a student proves they own a @purdue.edu mailbox by typing the
-- six-digit code mailed to it, and the address is linked the way a CAS link
-- is. Needs db/supabase-schema.sql (users) and nothing else. Idempotent - safe
-- to re-run.
--
-- One row per code sent. Only a SHA-256 hash of the code is stored, taken over
-- the row's id and the code, so a leaked row cannot be replayed. A new request
-- deletes the student's earlier rows, so each student has one live code at
-- most. Nothing is unique on email: a code claims nothing, and the UNIQUE on
-- users.purdue_email decides who holds an address when the code is verified.

CREATE TABLE IF NOT EXISTS purdue_email_challenges (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every route reads the student's newest row.
CREATE INDEX IF NOT EXISTS purdue_email_challenges_user_created_idx
  ON purdue_email_challenges (user_id, created_at DESC);

-- The server uses the service-role key (bypasses RLS) and enforces every rule
-- in code, like the other student tables. No policies: the Data API roles get
-- nothing.
ALTER TABLE purdue_email_challenges ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
