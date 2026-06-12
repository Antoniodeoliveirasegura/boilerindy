-- Run in Supabase SQL Editor (once). First-party product analytics (issue #51):
-- usage events land in our own Supabase — no third-party trackers. Idempotent —
-- safe to re-run.
--
-- Privacy posture:
--   * RLS enabled with NO policies: only the service-role key (the Node server)
--     can read or write. The anon/client key sees nothing.
--   * ON DELETE CASCADE: deleting a user wipes their analytics rows too.
--   * Event names are allowlisted server-side (analytics.mjs); props are capped.
--   * Retention: raw events older than 12 months are deleted (docs/analytics.md).

CREATE TABLE IF NOT EXISTS analytics_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (char_length(event_name) <= 100),
  page       TEXT CHECK (page IS NULL OR char_length(page) <= 300),
  props      JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS analytics_events_name_created_idx
  ON analytics_events (event_name, created_at);

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- Per-user analytics opt-out, surfaced as a Settings toggle. The server checks
-- this before inserting AND the client stops sending when it is true.
ALTER TABLE users ADD COLUMN IF NOT EXISTS analytics_opt_out BOOLEAN NOT NULL DEFAULT FALSE;

-- 12-month retention (run on a schedule — see docs/analytics.md):
--   DELETE FROM analytics_events WHERE created_at < NOW() - INTERVAL '12 months';
