-- Run in Supabase SQL Editor (once). Adds soft-delete support across user
-- content: a NULL `deleted_at` means the row is live; a timestamp means it was
-- soft-deleted (hidden from all normal listings). Recovery (restore) and
-- permanent (hard) deletion are admin-only — see the /api/admin/deleted/*
-- endpoints in server.mjs. Idempotent — safe to re-run.

ALTER TABLE board_posts            ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE marketplace_listings   ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE lost_found_items       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE guide_recommendations  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE deals                  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial indexes: normal listings filter `deleted_at IS NULL`, so index only
-- the live rows (keeps the index small and the common query fast).
CREATE INDEX IF NOT EXISTS idx_board_posts_live           ON board_posts (created_at DESC)          WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_live  ON marketplace_listings (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lost_found_items_live      ON lost_found_items (created_at DESC)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guide_recommendations_live ON guide_recommendations (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_live                 ON deals (created_at DESC)                 WHERE deleted_at IS NULL;

-- And index the soft-deleted rows for the admin moderation view (deleted_at NOT NULL).
CREATE INDEX IF NOT EXISTS idx_board_posts_deleted           ON board_posts (deleted_at DESC)          WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_deleted  ON marketplace_listings (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lost_found_items_deleted      ON lost_found_items (deleted_at DESC)      WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_guide_recommendations_deleted ON guide_recommendations (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_deleted                 ON deals (deleted_at DESC)                 WHERE deleted_at IS NOT NULL;
