-- Run in Supabase SQL Editor (once), after db/supabase-campus-events.sql
-- (README step 43). Downtown events (issue #30, docs/shared-campus-events.md):
-- widens the CHECK on campus_events.venue_kind to allow 'downtown', the venue
-- of every row a downtown source writes. The first one is White River State
-- Park's events calendar (source_key wrsp_events), which the ingest reads only
-- while CAMPUS_EVENTS_DOWNTOWN is on (docs/campus-events-ingest.md).
--
-- Until this runs nothing breaks: with the switch off nothing writes a
-- downtown row, and with it on a real ingest run leaves the downtown source
-- out with one log line naming this file, and writes and sweeps every other
-- source as before. The dry run works either way.
--
-- 'downtown' is never one of Jev's answers (src/campusEventsClassify.mjs asks
-- with the other five), so the stored verdicts stay current.
--
-- Writes no rows. Idempotent and safe to re-run: the CHECK is dropped and
-- added again under the same name, in one transaction, so no write can slip
-- in without it.

BEGIN;

ALTER TABLE campus_events DROP CONSTRAINT IF EXISTS campus_events_venue_kind_check;
ALTER TABLE campus_events ADD CONSTRAINT campus_events_venue_kind_check CHECK (venue_kind IN (
  'indy_campus', 'west_lafayette', 'online', 'elsewhere', 'unknown', 'downtown'
));

COMMIT;
