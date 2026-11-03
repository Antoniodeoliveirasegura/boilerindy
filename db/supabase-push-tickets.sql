-- Expo push receipts (issue #550, item 7). Expo answers each message with a
-- ticket, which only says it took the message; whether APNs or FCM took it
-- comes later, in a receipt (best read about 15 minutes after the send, kept
-- by Expo for 24 hours). push_tickets keeps each ticket id with the phone it
-- went to, and the reminder run (POST /api/internal/push/run-reminders) reads
-- the receipts of tickets older than 15 minutes, records each one's status
-- in `receipt` ('ok', an error code, or 'expired' when Expo no longer has
-- it), and deletes a phone on DeviceNotRegistered, so an uninstalled app is
-- dropped within the hour instead of at its next failed send. Logs carry
-- error codes only, never a token.
--
-- The index on push_deliveries (user_id, sent_at) serves the daily cap,
-- which counts a student's claims since campus midnight.
--
-- The retention job in db/supabase-retention.sql (README step 51) deletes
-- tickets older than 2 days; re-run that file after this one.
--
-- Needs db/supabase-push-devices.sql (README step 40) and
-- db/supabase-push.sql (step 30). Idempotent and safe to rerun; it adds a
-- table, so re-run db/supabase-anon-lockdown.sql (step 50) afterwards. Until
-- it runs nothing breaks: tickets are not kept, receipts are not read, and
-- the server log names this file once. See docs/push-notifications.md.

CREATE TABLE IF NOT EXISTS push_tickets (
  ticket_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  receipt TEXT,
  device_id UUID NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_tickets_unread ON push_tickets(sent_at) WHERE receipt IS NULL;
CREATE INDEX IF NOT EXISTS idx_push_deliveries_user_sent ON push_deliveries(user_id, sent_at);

ALTER TABLE push_tickets ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
