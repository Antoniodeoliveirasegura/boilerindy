-- =============================================================================
-- ATOMIC COMMUNITY COUNTERS
--
-- board_posts.reply_count, board_posts.upvote_count and
-- guide_recommendations.upvote_count are denormalized counters kept for the hot
-- read path (the board / guide list endpoints sort and display by them). They
-- used to be maintained with a read-modify-write: read N from a row fetched
-- earlier in the request, then write N + 1. Two simultaneous votes/replies both
-- read N and both write N + 1, so the stored count loses one update and drifts
-- below the real number of underlying rows.
--
-- Each function below recomputes a counter FROM its source rows inside a single
-- transaction, taking a row lock on the parent first so concurrent syncs
-- serialize. The last sync to run counts every committed vote/reply row, so the
-- stored value converges to the truth. This is correct under concurrency AND
-- self-healing: it also repairs whatever drift the old code already left behind.
--
-- The Node server (service_role) calls these via supabase.rpc(...). EXECUTE is
-- restricted to service_role so the public PostgREST endpoint cannot be used to
-- force-reset a count.
--
-- Run once in Supabase SQL Editor. Safe to re-run (CREATE OR REPLACE). No data
-- is deleted. Requires the board tables (db/supabase-schema.sql, or its
-- db/supabase-board-only.sql fallback) and db/supabase-neighborhood-guide.sql
-- to have been applied first.
-- =============================================================================

CREATE OR REPLACE FUNCTION sync_board_post_upvote_count(p_post_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  -- Serialize concurrent syncs on this post; the recount then sees every
  -- committed upvote row and the last writer stores the true total.
  PERFORM 1 FROM board_posts WHERE id = p_post_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM board_upvotes WHERE post_id = p_post_id;
  UPDATE board_posts SET upvote_count = v_count WHERE id = p_post_id;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION sync_board_post_reply_count(p_post_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM 1 FROM board_posts WHERE id = p_post_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM board_replies WHERE post_id = p_post_id;
  UPDATE board_posts SET reply_count = v_count WHERE id = p_post_id;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION sync_guide_rec_upvote_count(p_rec_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM 1 FROM guide_recommendations WHERE id = p_rec_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM guide_upvotes WHERE rec_id = p_rec_id;
  UPDATE guide_recommendations SET upvote_count = v_count WHERE id = p_rec_id;
  RETURN v_count;
END;
$$;

-- Only the server (service_role) may run these; keep them off the public API.
REVOKE ALL ON FUNCTION sync_board_post_upvote_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_board_post_reply_count(uuid)  FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_guide_rec_upvote_count(uuid)  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_board_post_upvote_count(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION sync_board_post_reply_count(uuid)  TO service_role;
GRANT EXECUTE ON FUNCTION sync_guide_rec_upvote_count(uuid)  TO service_role;

-- One-time (idempotent) repair of drift the old read-modify-write left behind.
-- Re-running is harmless: it just re-derives each counter from its source rows.
UPDATE board_posts p
   SET upvote_count = (SELECT count(*) FROM board_upvotes u WHERE u.post_id = p.id);
UPDATE board_posts p
   SET reply_count = (SELECT count(*) FROM board_replies r WHERE r.post_id = p.id);
UPDATE guide_recommendations g
   SET upvote_count = (SELECT count(*) FROM guide_upvotes v WHERE v.rec_id = g.id);

NOTIFY pgrst, 'reload schema';
