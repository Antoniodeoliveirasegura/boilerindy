-- Platform admins (student app). Run once in Supabase SQL Editor.
-- Admins can access owner-only API routes (advertiser leads, campaign review).
--
-- After this migration, grant admin to a user:
--   node scripts/grant-admin.mjs --email=you@gmail.com

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users (is_admin) WHERE is_admin = TRUE;

-- One-time grant (edit email as needed):
-- UPDATE users SET is_admin = TRUE WHERE email = 'you@gmail.com';
