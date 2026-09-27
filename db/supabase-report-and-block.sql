-- Run in Supabase SQL Editor (once). Report and block on every surface students
-- post to (issue #192). Needs db/supabase-schema.sql (users) and nothing else:
-- targets are referenced by type and id, not by foreign key, because they live
-- in seven different tables and a report must outlive a purged target.
-- Idempotent - safe to re-run.
--
-- content_reports is the one moderation queue: a board post or reply, a lost
-- and found item, a guide recommendation, a study group, a marketplace listing
-- or a user, reported once per reporter per target. Marketplace listings keep
-- their own marketplace_reports table too, because it drives the automatic
-- hide at three reporters; a listing report writes both.
--
-- blocked_users is one row per block. The server applies it in both
-- directions: a block by either side hides the two users from each other.

CREATE TABLE IF NOT EXISTS content_reports (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_type TEXT NOT NULL CHECK (target_type IN ('board_post', 'board_reply', 'lost_found', 'guide', 'study_group', 'marketplace', 'user')),
  target_id   UUID NOT NULL,
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL CHECK (reason IN ('spam', 'scam', 'harassment', 'prohibited', 'other')),
  details     TEXT NOT NULL DEFAULT '' CHECK (char_length(details) <= 500),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (target_type, target_id, reporter_id)
);

-- The admin queue reads by status, newest first; the target index serves the
-- per-target lookups (how often, and by whom, one thing was reported).
CREATE INDEX IF NOT EXISTS content_reports_status_created_idx
  ON content_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS content_reports_target_idx
  ON content_reports (target_type, target_id);

CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- The primary key covers "who did I block"; this covers "who blocked me", the
-- other half of the symmetric lookup.
CREATE INDEX IF NOT EXISTS blocked_users_blocked_idx
  ON blocked_users (blocked_id);

-- The server uses the service-role key (bypasses RLS) and enforces every rule
-- in code, like the other student tables. No policies: the Data API roles get
-- nothing.
ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
