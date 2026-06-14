-- Run in Supabase SQL Editor (once). Advertiser portal M2: campaigns owned by
-- advertisers. Depends on supabase-advertiser-portal.sql (advertisers table).
-- Idempotent — safe to re-run. Impression/tap logging (ad_events) is M3.
--
-- Approval flow: campaigns are created 'draft'. Advertisers submit for review
-- (-> pending_review); only the owner activates (-> active), enforced in the
-- Node server (advertiserCampaign.mjs transition map) — not in SQL.

CREATE TABLE IF NOT EXISTS campaigns (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  advertiser_id UUID NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  placement     TEXT NOT NULL CHECK (placement IN ('home-widget', 'side-rail', 'dining', 'transit', 'events')),
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'pending_review', 'active', 'paused', 'ended')),
  starts_on     DATE,
  ends_on       DATE,
  creative      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaigns_dates_ordered
    CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

-- Advertiser dashboard lists their own campaigns newest-first.
CREATE INDEX IF NOT EXISTS idx_campaigns_advertiser
  ON campaigns (advertiser_id, created_at DESC);
-- M3 ad serving will query by placement + status (active, in-window).
CREATE INDEX IF NOT EXISTS idx_campaigns_serving
  ON campaigns (placement, status);

-- Server uses the service-role key (bypasses RLS) and enforces ownership in code,
-- matching the existing advertisers/linked_sources pattern.
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

-- Reuses the shared updated_at trigger function created in supabase-schema.sql.
DROP TRIGGER IF EXISTS update_campaigns_updated_at ON campaigns;
CREATE TRIGGER update_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
