-- Run in Supabase SQL Editor (once). Enables the Student Marketplace (issue #32,
-- Phase 1): student-to-student listings with reports. Posting requires Purdue
-- verification (users.purdue_linked_at). A listing auto-hides at 3 distinct
-- reports pending admin review (users.is_admin).

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) >= 1 AND char_length(title) <= 120),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  category TEXT NOT NULL CHECK (category IN ('textbooks', 'furniture', 'electronics', 'housing', 'rideshare', 'tutoring', 'tickets', 'misc')),
  price_cents INT CHECK (price_cents IS NULL OR price_cents >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'removed')),
  image_url TEXT,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_browse ON marketplace_listings(status, category, created_at DESC) WHERE hidden = FALSE;

CREATE TABLE IF NOT EXISTS marketplace_reports (
  listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (listing_id, reporter_id)
);

ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_reports ENABLE ROW LEVEL SECURITY;
