-- =============================================================================
-- CALENDAR CATEGORY COUNTS
--
-- GET /api/me/calendar/categories (every dashboard and Assignments load) used to
-- select the category of every calendar_items row for the user and count them
-- in Node. That ships the whole column on each hydrate and, once a user has
-- more rows than PostgREST's max-rows (1000 on hosted projects), silently
-- under-counts, because the response is truncated without an error (issue #198).
--
-- calendar_category_counts groups in the database instead and returns one row
-- per category. It reads only (user_id, category), which the composite index
-- idx_calendar_items_user_category_start from db/supabase-calendar-indexes.sql
-- serves as an index-only scan.
--
-- The Node server (service_role) calls it via supabase.rpc(...). EXECUTE is
-- restricted to service_role so the public PostgREST endpoint cannot be used to
-- probe another user's calendar.
--
-- Run once in Supabase SQL Editor. Safe to re-run (CREATE OR REPLACE). Reads
-- only; no row is written or deleted. Requires db/supabase-schema.sql. Until it
-- runs the server still works: the route falls back to counting rows in Node.
-- =============================================================================

CREATE OR REPLACE FUNCTION calendar_category_counts(p_user_id uuid)
RETURNS TABLE (category text, item_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT ci.category, count(*) AS item_count
  FROM calendar_items ci
  WHERE ci.user_id = p_user_id
  GROUP BY ci.category;
$$;

-- Only the server (service_role) may run this; keep it off the public API.
-- Supabase also grants EXECUTE on new public functions to anon and authenticated
-- directly, so revoke those grants too, not just the PUBLIC one.
REVOKE ALL ON FUNCTION calendar_category_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION calendar_category_counts(uuid) TO service_role;

-- Reload PostgREST's schema cache so supabase.rpc() sees the new function right
-- away; otherwise it answers PGRST202 and the route keeps using the capped
-- fallback count without any visible error.
NOTIFY pgrst, 'reload schema';
