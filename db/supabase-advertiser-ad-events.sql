-- Run in Supabase SQL Editor (once). Advertiser portal M3: impression/tap log
-- for served ads. Depends on supabase-advertiser-campaigns.sql (campaigns table).
-- Idempotent - safe to re-run.
--
-- Privacy: this table stores NO student PII - only which campaign was shown/tapped
-- and when. Stats are aggregate counts (see GET /api/advertiser/campaigns/:id/stats).

CREATE TABLE IF NOT EXISTS ad_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('impression', 'tap')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stats roll up by campaign + kind.
CREATE INDEX IF NOT EXISTS idx_ad_events_campaign_kind
  ON ad_events (campaign_id, kind);

-- Server uses the service-role key (bypasses RLS) and enforces access in code,
-- matching the existing advertiser tables.
ALTER TABLE ad_events ENABLE ROW LEVEL SECURITY;
