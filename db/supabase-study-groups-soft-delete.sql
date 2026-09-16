-- Run in Supabase SQL Editor (once), after db/supabase-study-groups.sql. Adds
-- soft-delete support to study groups (issue #195) so a group's creator or an
-- admin can take it down: a NULL `deleted_at` means the group is live; a
-- timestamp means it is hidden from every study-group list. Members stay
-- attached, so an admin restore from the moderation view brings the group back
-- whole, and the admin hard delete cascades them. Idempotent - safe to re-run.
--
-- Until it runs the server still works: the study-group lists skip the filter,
-- while DELETE /api/study-groups/:id and the study-group tab of the admin
-- moderation view answer 503 naming this file.

ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial indexes, as in db/supabase-soft-delete.sql: live rows for the normal
-- lists, soft-deleted rows for the admin moderation view.
CREATE INDEX IF NOT EXISTS idx_study_groups_live    ON study_groups (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_study_groups_deleted ON study_groups (deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- Reload PostgREST's schema cache so the new column is visible right away;
-- otherwise the takedown update answers PGRST204 until the cache refreshes.
NOTIFY pgrst, 'reload schema';
