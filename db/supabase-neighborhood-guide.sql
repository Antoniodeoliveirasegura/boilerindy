-- Run in Supabase SQL Editor (once). Enables the Neighborhood Guide (issue #31):
-- student-submitted local recommendations with category, optional map pin, and
-- upvotes. Admin pinning reuses users.is_admin (db/supabase-admin-users.sql).

CREATE TABLE IF NOT EXISTS guide_recommendations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('food', 'study', 'parking', 'safety', 'other')),
  title TEXT NOT NULL CHECK (char_length(title) >= 1 AND char_length(title) <= 120),
  body TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 1000),
  place_name TEXT CHECK (place_name IS NULL OR char_length(place_name) <= 120),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  upvote_count INT NOT NULL DEFAULT 0,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guide_recs_category ON guide_recommendations(category);
CREATE INDEX IF NOT EXISTS idx_guide_recs_rank ON guide_recommendations(pinned DESC, upvote_count DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS guide_upvotes (
  rec_id UUID NOT NULL REFERENCES guide_recommendations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (rec_id, user_id)
);

ALTER TABLE guide_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_upvotes ENABLE ROW LEVEL SECURITY;
