-- =============================================================================
-- USER_ID INDEXES FOR THE "MINE" READS AND THE ACCOUNT-DELETION CASCADE
--
-- Run in Supabase SQL Editor (once). Index-only change: no row is read,
-- written, or deleted. Safe to re-run (CREATE INDEX IF NOT EXISTS).
--
-- Four tables carry user_id UUID NOT NULL REFERENCES users(id) ON DELETE
-- CASCADE with no index that leads with that column, so every lookup by owner
-- is a sequential scan. Two things pay for it (issue #212).
--
-- The owner reads. GET /api/marketplace/mine filters marketplace_listings by
-- user_id, drops soft-deleted rows and orders by created_at DESC.
-- GET /api/me/study-groups filters study_group_members by user_id alone; its
-- primary key is (group_id, user_id), and a composite cannot serve a lookup
-- that does not constrain its leading column.
--
-- Account deletion. DELETE /api/me runs a single delete against users
-- (server.mjs), and Postgres then executes DELETE FROM <child> WHERE user_id
-- = $1 once per referencing table. That statement is why board_posts and
-- guide_recommendations are here: neither has a live read filtered by owner
-- alone (the board scopes by primary key, the guide goes through
-- ownerOrAdminScope after .eq('id', ...)), but both are scanned end to end
-- every time a student deletes their account.
--
-- The indexes are plain, with no WHERE clause. A partial index on
-- deleted_at IS NULL would serve the /mine reads and be unusable for the
-- cascade, because the planner only picks a partial index when the query's own
-- WHERE implies the index predicate, and the cascade's does not. Leading with
-- user_id and trailing created_at DESC serves both: the cascade uses the
-- leading column, the /mine read gets its ordering for free and applies the
-- deleted_at filter to the few rows that come back.
--
-- Needs steps 1, 13, 15 and 16 (board_posts, marketplace_listings,
-- guide_recommendations, study_group_members). Until it runs nothing breaks:
-- those two reads and the account-deletion cascade scan the table.
-- =============================================================================

-- GET /api/marketplace/mine, and the cascade from DELETE /api/me.
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_user  ON marketplace_listings (user_id, created_at DESC);

-- GET /api/me/study-groups. The primary key (group_id, user_id) cannot serve a
-- filter on user_id alone.
CREATE INDEX IF NOT EXISTS idx_study_group_members_user   ON study_group_members (user_id);

-- No owner-only read today; these two are for the cascade from DELETE /api/me.
-- created_at DESC costs nothing extra and is the order any future /mine read
-- on these tables would want.
CREATE INDEX IF NOT EXISTS idx_board_posts_user           ON board_posts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guide_recommendations_user ON guide_recommendations (user_id, created_at DESC);
