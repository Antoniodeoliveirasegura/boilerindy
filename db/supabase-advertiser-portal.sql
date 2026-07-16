-- Run in Supabase SQL Editor (once). Creates the advertiser portal backend
-- (advertiser-portal M1): businesses/marketers sign in separately from students
-- and request access before an account exists. Isolated from the student `users`
-- table on purpose - advertisers must never reach student data (enforced in the
-- Node server via a distinct session key + requireAdvertiserAuth). Idempotent -
-- safe to re-run. Campaigns + ad_events land in later milestones.

-- Advertiser accounts. Invite-only: rows are minted by scripts/create-advertiser.mjs
-- (no self-serve signup endpoint). Password hashing matches the student auth
-- helper (scrypt, `salt:hash`) via passwordHash.mjs.
CREATE TABLE IF NOT EXISTS advertisers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  company_name  TEXT NOT NULL CHECK (char_length(company_name) BETWEEN 1 AND 200),
  contact_name  TEXT CHECK (contact_name IS NULL OR char_length(contact_name) <= 200),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Captures "Request advertiser access" submissions from /advertise before an
-- account exists. No auth required to insert; reviewed manually for onboarding.
CREATE TABLE IF NOT EXISTS advertiser_leads (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email        TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  company_name TEXT CHECK (company_name IS NULL OR char_length(company_name) <= 200),
  message      TEXT CHECK (message IS NULL OR char_length(message) <= 2000),
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advertisers_email        ON advertisers (email);
CREATE INDEX IF NOT EXISTS idx_advertiser_leads_created ON advertiser_leads (created_at DESC);

-- Server uses the service-role key (bypasses RLS) and enforces ownership in code,
-- matching the existing users/linked_sources pattern.
ALTER TABLE advertisers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE advertiser_leads ENABLE ROW LEVEL SECURITY;

-- Reuses the shared updated_at trigger function created in supabase-schema.sql.
DROP TRIGGER IF EXISTS update_advertisers_updated_at ON advertisers;
CREATE TRIGGER update_advertisers_updated_at
  BEFORE UPDATE ON advertisers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
