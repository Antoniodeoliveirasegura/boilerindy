-- =============================================================================
-- ATOMIC STUDY GROUP JOIN
--
-- POST /api/study-groups/:id/join used to read the member rows, compare their
-- number with study_groups.capacity and then insert in a separate statement.
-- Two students joining a group with one seat left both read count = capacity - 1,
-- both pass the check and both insert, so the group ends up over capacity
-- (issue #207). The primary key on (group_id, user_id) already stopped one
-- student joining twice; nothing stopped two different students.
--
-- join_study_group takes a row lock on the group before counting, so concurrent
-- joins serialize: the second transaction waits, then counts the first one's
-- committed row and is told the group is full. Count, check and insert all
-- happen inside one transaction, which is what closes the race.
--
-- Soft delete: this function deliberately ignores study_groups.deleted_at. That
-- column arrives with db/supabase-study-groups-soft-delete.sql, which is
-- optional, so naming it here would break this function wherever that step has
-- not run. The server checks the group is live before calling in, and EXECUTE is
-- restricted to service_role, so the public PostgREST endpoint cannot be used to
-- join a taken-down group.
--
-- The Node server (service_role) calls this through supabase.rpc(...). Until it
-- runs, src/studyGroupJoin.mjs falls back to the old read-then-insert: joins keep
-- working and stay racy, and nothing else changes.
--
-- Run once in Supabase SQL Editor. Safe to re-run (CREATE OR REPLACE). No data
-- is deleted. Requires db/supabase-study-groups.sql (step 16).
--
-- Verify by hand: take a group with capacity 2 that already has one member, open
-- two SQL Editor sessions and in each run, with a different user id,
--   BEGIN;
--   SELECT join_study_group('<group-uuid>', '<user-uuid>');
-- The second session blocks on the row lock until the first commits, and then
-- answers {"status": "full", ...}. COMMIT both when done.
-- =============================================================================

CREATE OR REPLACE FUNCTION join_study_group(p_group_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_capacity integer;
  v_count integer;
  v_already boolean;
BEGIN
  -- Serialize concurrent joins on this group. Every branch below reads the
  -- member rows after this lock, so each transaction sees the ones already
  -- committed rather than the snapshot it started with.
  SELECT capacity INTO v_capacity FROM study_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM study_group_members WHERE group_id = p_group_id AND user_id = p_user_id
  ) INTO v_already;
  SELECT count(*) INTO v_count FROM study_group_members WHERE group_id = p_group_id;

  -- Already a member: idempotent, and never "full" even if the group is over
  -- capacity from before this function was installed.
  IF v_already THEN
    RETURN jsonb_build_object('status', 'already', 'member_count', v_count);
  END IF;

  -- capacity IS NULL means the group has no limit.
  IF v_capacity IS NOT NULL AND v_count >= v_capacity THEN
    RETURN jsonb_build_object('status', 'full', 'member_count', v_count);
  END IF;

  INSERT INTO study_group_members (group_id, user_id, joined_at)
  VALUES (p_group_id, p_user_id, now());

  RETURN jsonb_build_object('status', 'joined', 'member_count', v_count + 1);
END
$$;

-- Only the Node server (service_role) may join someone to a group; the public
-- PostgREST roles must go through the route, which checks the session first.
REVOKE ALL ON FUNCTION join_study_group(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_study_group(uuid, uuid) TO service_role;
