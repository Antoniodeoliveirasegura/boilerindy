-- =============================================================================
-- CAMPUS BOARD — REQUIRED for /api/board/* (fixes "schema cache" / missing table)
--
-- Supabase may warn: "destructive operations" — usually from CREATE OR REPLACE
-- FUNCTION below. That only defines/updates the shared updated_at helper used by
-- several tables; it does NOT delete data. Safe to confirm and run.
--
-- 1. https://supabase.com/dashboard → your project
-- 2. SQL Editor → New query
-- 3. Paste this ENTIRE file → Run (confirm if prompted)
-- 4. Wait ~30s, then restart BoilerIndy Node
--
-- Requires: public.users (main BoilerIndy supabase-schema.sql).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS board_posts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (char_length(title) >= 1 AND char_length(title) <= 300),
  body         TEXT NOT NULL DEFAULT '',
  is_anon      BOOLEAN NOT NULL DEFAULT FALSE,
  pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  upvote_count INTEGER NOT NULL DEFAULT 0,
  reply_count  INTEGER NOT NULL DEFAULT 0,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE board_posts ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS board_replies (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id    UUID NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (char_length(body) >= 1 AND char_length(body) <= 2000),
  is_anon    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS board_upvotes (
  post_id    UUID NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_board_posts_created_at   ON board_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_posts_upvote_count ON board_posts(upvote_count DESC);
CREATE INDEX IF NOT EXISTS idx_board_replies_post_id    ON board_replies(post_id);
CREATE INDEX IF NOT EXISTS idx_board_upvotes_post_id    ON board_upvotes(post_id);
CREATE INDEX IF NOT EXISTS idx_board_upvotes_user_id    ON board_upvotes(user_id);

ALTER TABLE board_posts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_upvotes ENABLE ROW LEVEL SECURITY;

-- No DROP TRIGGER (avoids Supabase "destructive query" warning). Safe to re-run.
DO $board_trg$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE t.tgname = 'update_board_posts_updated_at'
      AND c.relname = 'board_posts'
      AND n.nspname = 'public'
  ) THEN
    CREATE TRIGGER update_board_posts_updated_at
      BEFORE UPDATE ON board_posts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END;
$board_trg$;

NOTIFY pgrst, 'reload schema';
