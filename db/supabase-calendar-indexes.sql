-- Run in Supabase SQL Editor (once). Index-only change: no row is read, written, or deleted.
-- Speeds up every calendar, class, and category read. Safe to re-run.

-- The dominant read is listCalendarItems (server.mjs): filter by user, optionally by
-- category, bound start_time, then ORDER BY start_time. Until now the table carried
-- four single-column indexes, so Postgres could use only one of those three predicates
-- and had to sort the rest by hand.

-- Covers /api/me/calendar with ?categories=, /api/me/events, and getClassItemsForUser
-- (category = 'class'). Also serves /api/me/calendar/categories, which reads only the
-- category column for one user and becomes an index-only scan here.
CREATE INDEX IF NOT EXISTS idx_calendar_items_user_category_start
  ON calendar_items(user_id, category, start_time);

-- Covers the same read with no category filter, where the composite above cannot supply
-- an ordered range because its middle column is unconstrained.
CREATE INDEX IF NOT EXISTS idx_calendar_items_user_start
  ON calendar_items(user_id, start_time);

-- user_id alone is now a leading prefix of both composites, so this index can never be
-- the better plan and only costs write time. Sync replaces every row for a source
-- (calendarItemStore.replaceItems inserts in batches of 500), so that cost is paid
-- often. Dropping an index is instantly reversible: re-create it with
--   CREATE INDEX idx_calendar_items_user_id ON calendar_items(user_id);
DROP INDEX IF EXISTS idx_calendar_items_user_id;
