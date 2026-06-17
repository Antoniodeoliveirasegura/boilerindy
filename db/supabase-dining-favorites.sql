-- Run in Supabase SQL Editor (once). Enables Dining favorites (issue #49):
-- per-user favorited menu-item names (normalized lowercase) used to highlight
-- "your favorites on today's menu" on the Dining page.

CREATE TABLE IF NOT EXISTS user_dining_favorites (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL CHECK (char_length(item_name) >= 1 AND char_length(item_name) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, item_name)
);

CREATE INDEX IF NOT EXISTS idx_user_dining_favorites_user ON user_dining_favorites(user_id);

ALTER TABLE user_dining_favorites ENABLE ROW LEVEL SECURITY;
