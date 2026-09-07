-- #9: Web Push notifications - device subscriptions, per-user reminder
-- settings, and a delivery log so each deadline is announced exactly once.
--
-- The Node server talks to these tables with SUPABASE_SERVICE_ROLE_KEY. RLS is
-- enabled with no policies so the public anon key cannot read push endpoints
-- (which are capability URLs: anyone holding one can send that device a
-- message) over the Data API. See the RLS note in db/supabase-schema.sql;
-- test/rlsCoverage.test.mjs enforces this for every table in db/.
--
-- Until this runs, the /api/push/* routes answer 503 push_not_configured and
-- the Settings page shows "not set up on this server yet". Nothing breaks.
--
-- Safe to run more than once.

-- One row per browser/device registration. `endpoint` is the push service URL
-- the browser handed out; it is unique per device, so re-registering the same
-- device upserts instead of duplicating.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE CHECK (char_length(endpoint) <= 2048),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time TIMESTAMPTZ,
  user_agent TEXT CHECK (user_agent IS NULL OR char_length(user_agent) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- Per-user reminder preferences. No row means the defaults (reminders on,
-- 60 minutes ahead); the server upserts on the first change.
CREATE TABLE IF NOT EXISTS push_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  deadline_reminders BOOLEAN NOT NULL DEFAULT TRUE,
  lead_minutes INTEGER NOT NULL DEFAULT 60 CHECK (lead_minutes BETWEEN 5 AND 10080),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reminder ledger. The runner INSERTs (user_id, item_key) before sending, so a
-- second overlapping run hits the primary key and skips the item. item_key is
-- "calendar:<calendar_items.id>" or "manual:<user_manual_tasks.id>".
CREATE TABLE IF NOT EXISTS push_deliveries (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK (char_length(item_key) <= 200),
  kind TEXT NOT NULL DEFAULT 'deadline',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_push_deliveries_sent_at ON push_deliveries(sent_at);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_deliveries ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_push_settings_updated_at ON push_settings;
CREATE TRIGGER update_push_settings_updated_at
  BEFORE UPDATE ON push_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ── Reminder trigger (optional second step) ─────────────────────────────────
-- Reminders are sent when something calls POST /api/internal/push/run-reminders
-- with the PUSH_CRON_SECRET bearer token. The Supabase scheduler can do that
-- every 5 minutes (it also keeps the Render instance awake, issue #164).
-- Requires the pg_cron and pg_net extensions from db/supabase-keep-warm.sql.
-- Replace <PUSH_CRON_SECRET> with the value set on Render, then run:
--
--   select cron.schedule(
--     'boilerindy-push-reminders',
--     '*/5 * * * *',
--     $$
--     select net.http_post(
--       url := 'https://boilerindy-api.onrender.com/api/internal/push/run-reminders',
--       headers := '{"Authorization": "Bearer <PUSH_CRON_SECRET>", "Content-Type": "application/json"}'::jsonb,
--       body := '{}'::jsonb,
--       timeout_milliseconds := 60000
--     );
--     $$
--   );
--
-- Remove with: select cron.unschedule('boilerindy-push-reminders');

-- Housekeeping, run whenever: the ledger only needs to outlive the items it
-- guards, so rows older than 60 days can go.
--   DELETE FROM push_deliveries WHERE sent_at < NOW() - INTERVAL '60 days';
