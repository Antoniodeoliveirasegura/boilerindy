-- Supabase Schema for BoilerIndy
-- Run this in your Supabase SQL Editor to create the required tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  auth_provider TEXT NOT NULL DEFAULT 'local',
  avatar_url TEXT,
  purdue_email TEXT UNIQUE,
  purdue_username TEXT,
  purdue_linked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Linked sources table (for ICS feeds, etc.)
CREATE TABLE IF NOT EXISTS linked_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  label TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Calendar items table (classes, events)
CREATE TABLE IF NOT EXISTS calendar_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES linked_sources(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  location TEXT,
  category TEXT NOT NULL,
  external_uid TEXT NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT FALSE,
  raw_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id, external_uid)
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_purdue_email ON users(purdue_email);
CREATE INDEX IF NOT EXISTS idx_linked_sources_user_id ON linked_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_items_user_id ON calendar_items(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_items_source_id ON calendar_items(source_id);
CREATE INDEX IF NOT EXISTS idx_calendar_items_category ON calendar_items(category);
CREATE INDEX IF NOT EXISTS idx_calendar_items_start_time ON calendar_items(start_time);

-- Row Level Security (RLS) policies
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE linked_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_items ENABLE ROW LEVEL SECURITY;

-- Note: Since we're using server-side auth (not Supabase Auth), 
-- we'll use the service role key which bypasses RLS.
-- If you want to enable RLS for additional security, you can create policies here.

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to auto-update updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_linked_sources_updated_at ON linked_sources;
CREATE TRIGGER update_linked_sources_updated_at
  BEFORE UPDATE ON linked_sources
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_calendar_items_updated_at ON calendar_items;
CREATE TRIGGER update_calendar_items_updated_at
  BEFORE UPDATE ON calendar_items
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Student Board
-- ============================================================

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

-- Add tags column if table already exists
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

-- Board rows are read/written by the BoilerIndy Node server (SUPABASE_SERVICE_ROLE_KEY),
-- which bypasses RLS. Endpoints: GET/POST /api/board/posts, reply, upvote.

DROP TRIGGER IF EXISTS update_board_posts_updated_at ON board_posts;
CREATE TRIGGER update_board_posts_updated_at
  BEFORE UPDATE ON board_posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
