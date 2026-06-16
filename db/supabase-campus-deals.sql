-- Run in Supabase SQL Editor (once). Enables Campus Perks (issue #24):
-- admin-curated local deals for students. Admin gating reuses users.is_admin
-- (db/supabase-admin-users.sql).

CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_name TEXT NOT NULL CHECK (char_length(business_name) >= 1 AND char_length(business_name) <= 120),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  image_url TEXT,
  category TEXT NOT NULL CHECK (category IN ('food', 'coffee', 'entertainment', 'services', 'other')),
  address TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  expires_at TIMESTAMPTZ,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deals_active ON deals(active, category) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_deals_featured ON deals(featured) WHERE featured = TRUE;

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
