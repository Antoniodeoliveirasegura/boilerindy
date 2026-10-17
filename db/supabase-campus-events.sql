-- Run in Supabase SQL Editor (once). Shared campus events (issue #30,
-- docs/shared-campus-events.md): one row per event from a public campus
-- calendar, the same row for every student. Only the ingest cron route
-- POST /api/internal/campus-events/ingest writes it (src/campusEventsIngest.mjs,
-- docs/campus-events-ingest.md), and nothing reads it yet: the read path is a
-- later change behind a flag. Needs db/supabase-schema.sql (the uuid-ossp
-- extension and update_updated_at_column()) and nothing else. Idempotent -
-- safe to re-run.
--
-- Deliberately no user_id. Rows come from public feeds only, never from a
-- student's Brightspace or timetable calendar (see the design doc for why).
--
-- dedupe_key is `<source_key>:<the feed's own id>`, or the design doc's hash
-- of title, start and location for a row without an id, and every write is an
-- upsert on it. The ingest sets last_seen_at on every row it writes and, after
-- a complete fetch of a source, deletes that source's rows it did not write.
--
-- The columns past the design sketch hold what the ingest derives from the
-- source's own signals (docs/campus-events-ingest.md):
--   category      the kind of event, from the source's types or theme; NULL when
--                 the source says nothing usable. The keys are the choices of the
--                 planned Jev category question, plus `deadline` for the
--                 official academic dates in Purdue's calendar.
--   free_food     the source's own tag (LiveWhale "Free food", Engage "Free
--                 Food"), free admission plus food in the listing, or the
--                 keyword matcher in src/freeFood.mjs.
--   venue_kind    where it happens, with the keys of the planned Jev `where`
--                 question so a later verdict can replace the rule's answer.
--   open_to_all   false for a members-only session (practice, rehearsal, officer
--                 meeting), true when the source lists students or the public
--                 as the audience, NULL when nothing says.
--   series_key    shared by the occurrences of one recurring listing, so a read
--                 can show a weekly practice once.
--   content_hash  sha256 of the title, description and location: the text a
--                 classifier reads.
--   classifier    the Jev hook. NULL until a classifier verdict is stored (the
--                 model id, the answers and probabilities, classified_at); the
--                 deterministic ingest never writes it. The trigger below clears
--                 it when content_hash changes, so `classifier IS NULL` is the
--                 queue of rows to classify and an edited listing is asked again.

CREATE TABLE IF NOT EXISTS campus_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         TEXT NOT NULL,
  description   TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ,
  location      TEXT,
  all_day       BOOLEAN NOT NULL DEFAULT FALSE,

  source_key    TEXT NOT NULL,
  source_url    TEXT,
  external_uid  TEXT,

  dedupe_key    TEXT NOT NULL,
  category      TEXT CHECK (category IN (
                  'career', 'academic', 'social', 'club_business', 'sports_fitness',
                  'arts_culture', 'service', 'faith', 'wellness', 'deadline', 'other'
                )),
  free_food     BOOLEAN NOT NULL DEFAULT FALSE,
  venue_kind    TEXT NOT NULL DEFAULT 'unknown' CHECK (venue_kind IN (
                  'indy_campus', 'west_lafayette', 'online', 'elsewhere', 'unknown'
                )),
  open_to_all   BOOLEAN,
  series_key    TEXT,
  content_hash  TEXT NOT NULL,
  classifier    JSONB,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (dedupe_key)
);

-- The read path will list upcoming events by start time.
CREATE INDEX IF NOT EXISTS idx_campus_events_starts_at ON campus_events(starts_at);
-- The ingest's sweep: DELETE ... WHERE source_key = $1 AND last_seen_at < $2.
CREATE INDEX IF NOT EXISTS idx_campus_events_source_seen ON campus_events(source_key, last_seen_at);

-- The server uses the service-role key (bypasses RLS). No policies: the Data
-- API roles get nothing, as for every table in db/ (test/rlsCoverage.test.mjs).
ALTER TABLE campus_events ENABLE ROW LEVEL SECURITY;

-- Reuses the shared updated_at trigger function created in supabase-schema.sql.
DROP TRIGGER IF EXISTS update_campus_events_updated_at ON campus_events;
CREATE TRIGGER update_campus_events_updated_at
  BEFORE UPDATE ON campus_events
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- A stored verdict answers the text it was asked about. When a write changes
-- content_hash without bringing a verdict of its own, the old one is cleared.
-- A classifier that writes the new hash and its verdict together keeps it.
CREATE OR REPLACE FUNCTION campus_events_clear_stale_classifier()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.content_hash IS DISTINCT FROM OLD.content_hash
     AND NEW.classifier IS NOT DISTINCT FROM OLD.classifier THEN
    NEW.classifier = NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campus_events_clear_stale_classifier ON campus_events;
CREATE TRIGGER campus_events_clear_stale_classifier
  BEFORE UPDATE OF content_hash ON campus_events
  FOR EACH ROW
  EXECUTE FUNCTION campus_events_clear_stale_classifier();

NOTIFY pgrst, 'reload schema';
