-- Run in Supabase SQL Editor (once). Enables the subscribable ICS calendar
-- feed (issue #48): a per-user secret token that authorizes the public
-- /feeds/calendar/<token>.ics endpoint. Idempotent - safe to re-run.

ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_feed_token UUID;

-- The token is the only credential on the feed URL, so it must resolve to at
-- most one user. A partial unique index enforces that without tripping over the
-- many rows where the column is still NULL (token minted lazily on first use).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_calendar_feed_token
  ON users (calendar_feed_token)
  WHERE calendar_feed_token IS NOT NULL;
