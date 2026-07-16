-- Run in Supabase SQL Editor (once). Advertiser self-serve password reset
-- (forgot-password). Depends on supabase-advertiser-portal.sql (advertisers
-- table). Idempotent - safe to re-run.
--
-- Security: we store only the SHA-256 HASH of each reset token, never the raw
-- token (that lives only in the emailed link). Tokens are single-use (used_at)
-- and short-lived (expires_at, 1h - enforced in advertiserPasswordReset.mjs).

CREATE TABLE IF NOT EXISTS advertiser_password_resets (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  advertiser_id UUID NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reset submissions look up the row by token hash; cleanup/invalidate by owner.
CREATE INDEX IF NOT EXISTS idx_adv_pw_resets_token_hash
  ON advertiser_password_resets (token_hash);
CREATE INDEX IF NOT EXISTS idx_adv_pw_resets_advertiser
  ON advertiser_password_resets (advertiser_id);

-- Server uses the service-role key (bypasses RLS) and enforces logic in code,
-- matching the existing advertiser tables. No client ever reads this table.
ALTER TABLE advertiser_password_resets ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
