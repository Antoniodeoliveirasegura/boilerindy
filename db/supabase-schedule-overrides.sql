-- Schedule corrections that survive an ICS re-sync: hidden meeting series, edited
-- details (code/name/room/time/days) and manually added class blocks.
--
-- These lived in browser localStorage, which meant they vanished on a new device
-- and were invisible to the campus assistant - it would happily talk about a class
-- the student had deleted. One JSONB document per user mirrors how the client
-- reads and writes the whole override state as a unit.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS user_schedule_overrides (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- { "<seriesKey>": { code, name, room, startHm, endHm, days[], hidden } }
  series JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- [ { id, code, name, room, days[], startHm, endHm } ]
  manual JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_schedule_overrides ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_user_schedule_overrides_updated_at ON user_schedule_overrides;
CREATE TRIGGER update_user_schedule_overrides_updated_at
  BEFORE UPDATE ON user_schedule_overrides
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
