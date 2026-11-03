-- Campus alert pushes (issue #550, item 9; issue #34). IU's alert feed for the
-- Indianapolis campus holds one message at a time, the latest, and the
-- push fast tick (POST /api/internal/push/fast-tick, which the pg_cron job
-- in db/supabase-push-fast-tick.sql calls) reads it through the banner's
-- cache. The tick keeps each message it sees once and groups the messages into
-- incidents: an emergency's first message opens one, and IU's "Campus Status
-- Normal" closes it. The first message is pushed (the campus-alert kind) and so
-- is the Normal that closes it (campus-all-clear), once each: alert_pushed_at
-- and clear_pushed_at are claimed before the push, so overlapping ticks, or a
-- second instance during a deploy, never send twice. Updates and finals only
-- change the banner. See src/campusAlertPush.mjs and docs/campus-alerts.md.
--
-- campus_alert_messages: one row per message, keyed by its source and the
-- source's identifier, with the role the tick gave it: new (opened an
-- incident), update, final, normal (closed what was open) or test. IU's tests
-- open incidents of their own (test true), pushed to admins only. The source
-- 'purduealert' is for a second source later.
--
-- The retention jobs in db/supabase-retention.sql (README step 51) delete both
-- after 12 months; re-run that file after this one.
--
-- Needs db/supabase-schema.sql (README step 1) for uuid_generate_v4().
-- Idempotent and safe to rerun; it adds tables, so re-run
-- db/supabase-anon-lockdown.sql (step 50) afterwards. Until it runs nothing
-- breaks: the tick pushes nothing and the server log names this file once,
-- and the banners work as before.

CREATE TABLE IF NOT EXISTS campus_alert_incidents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  test BOOLEAN NOT NULL DEFAULT FALSE,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  alert_pushed_at TIMESTAMPTZ,
  clear_pushed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS campus_alert_messages (
  source TEXT NOT NULL CHECK (source IN ('iu', 'purduealert')),
  source_id TEXT NOT NULL,
  incident_id UUID REFERENCES campus_alert_incidents(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('new', 'update', 'final', 'normal', 'test')),
  sent_at TIMESTAMPTZ NOT NULL,
  headline TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_campus_alert_incidents_open ON campus_alert_incidents(opened_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_campus_alert_messages_incident ON campus_alert_messages(incident_id, sent_at);

ALTER TABLE campus_alert_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus_alert_messages ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
