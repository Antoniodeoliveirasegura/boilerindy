-- Run in Supabase SQL Editor (once). Following a club (issue #16): a student
-- follows BoilerLink organizations from the /clubs page, and /events and
-- /free-food can then list the followed clubs' events on their own. See
-- docs/clubs.md#following-a-club. Needs db/supabase-schema.sql (users) and
-- db/supabase-campus-events.sql (campus_events). Idempotent and safe to re-run;
-- it writes no rows.
--
-- campus_events.organization_key says which Engage organization listed an
-- event: `boilerlink:<Id>` on BoilerLink, `thespot:<Id>` on TheSpot, the Id
-- being the organization's (the club directory's `id`, src/boilerlinkClubs.mjs).
-- NULL for the Purdue and IU calendars, which name no organization, and for an
-- Engage listing without one. A Purdue calendar row that absorbed the same
-- event from BoilerLink keeps that copy's key (collapseCrossSource in
-- src/sharedEvents.mjs). The ingest writes it on every run, so the first run
-- after this file fills the existing rows. No CHECK here: the normalizer only
-- writes a well-formed key, and one odd listing must never fail a whole batch.
--
-- club_follows holds one row per student and club followed, at most 100 per
-- student (src/userWriteCaps.mjs). The CHECK repeats the key rule of
-- parseOrganizationKey in src/sharedEvents.mjs. Deleting the account deletes
-- the student's follows through the foreign key.
--
-- Until this runs nothing breaks: the ingest writes its rows without the
-- column and the server log names this file once, the Events and Free Food
-- reads list every row as before with no club marked as followed, and the
-- follow routes answer 503 club_follows_schema_missing.

ALTER TABLE campus_events ADD COLUMN IF NOT EXISTS organization_key TEXT;

-- Only Engage rows carry a key, so the index leaves the calendar rows out.
CREATE INDEX IF NOT EXISTS idx_campus_events_organization_key
  ON campus_events(organization_key)
  WHERE organization_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS club_follows (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_key TEXT NOT NULL CHECK (organization_key ~ '^(boilerlink|thespot):[1-9][0-9]{0,11}$'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Leads with user_id, so it also serves the per-student read and the
  -- account-deletion cascade without an index of its own.
  PRIMARY KEY (user_id, organization_key)
);

-- The server uses the service-role key (bypasses RLS). No policies: the Data
-- API roles get nothing, as for every table in db/ (test/rlsCoverage.test.mjs).
ALTER TABLE club_follows ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
