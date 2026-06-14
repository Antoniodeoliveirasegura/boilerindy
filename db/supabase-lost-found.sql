-- Run in Supabase SQL Editor (once). Enables the standalone Lost & Found
-- feature (issue #47): students post lost or found items and mark them
-- resolved. Independent of the campus board. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS lost_found_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('lost', 'found')),
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 2000),
  location    TEXT CHECK (location IS NULL OR char_length(location) <= 200),
  contact     TEXT CHECK (contact IS NULL OR char_length(contact) <= 200),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The feed is browsed newest-first, usually filtered by status/type.
CREATE INDEX IF NOT EXISTS idx_lost_found_status_created
  ON lost_found_items (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lost_found_user
  ON lost_found_items (user_id);

ALTER TABLE lost_found_items ENABLE ROW LEVEL SECURITY;

-- Reuses the shared updated_at trigger function created in supabase-schema.sql.
DROP TRIGGER IF EXISTS update_lost_found_items_updated_at ON lost_found_items;
CREATE TRIGGER update_lost_found_items_updated_at
  BEFORE UPDATE ON lost_found_items
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
