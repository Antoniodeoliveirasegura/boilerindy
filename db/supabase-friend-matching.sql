-- Run in Supabase SQL Editor (once). Enables Friend Matching (issue #17):
-- connect students who share courses. Privacy is opt-in (discoverable, default
-- off). Pre-acceptance, only display name, interests, and shared-course count
-- are exposed — never email or schedule details.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio TEXT NOT NULL DEFAULT '' CHECK (char_length(bio) <= 300),
  interests TEXT[] NOT NULL DEFAULT '{}',
  discoverable BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connections (
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_connections_addressee ON connections(addressee_id, status);

-- Snapshot of a discoverable user's course codes, refreshed when they opt in.
-- Powers shared-course matching without scanning every user's schedule.
CREATE TABLE IF NOT EXISTS friend_match_courses (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_code TEXT NOT NULL CHECK (char_length(course_code) BETWEEN 1 AND 20),
  PRIMARY KEY (user_id, course_code)
);
CREATE INDEX IF NOT EXISTS idx_friend_match_courses_code ON friend_match_courses(course_code);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE friend_match_courses ENABLE ROW LEVEL SECURITY;
