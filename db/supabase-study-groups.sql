-- Run in Supabase SQL Editor (once). Enables the Study Group Finder (issue #33):
-- per-course study groups built on the user's synced class schedule. Privacy is
-- opt-in (default off); only opted-in users are counted as classmates, and a
-- snapshot of their course codes powers those counts without exposing names.

ALTER TABLE users ADD COLUMN IF NOT EXISTS study_groups_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS study_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_code TEXT NOT NULL CHECK (char_length(course_code) BETWEEN 1 AND 20),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  meeting_info TEXT NOT NULL DEFAULT '' CHECK (char_length(meeting_info) <= 200),
  capacity INT CHECK (capacity IS NULL OR (capacity >= 2 AND capacity <= 100)),
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_study_groups_course ON study_groups(course_code);

CREATE TABLE IF NOT EXISTS study_group_members (
  group_id UUID NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- Snapshot of an opted-in user's course codes, refreshed on opt-in. Powers the
-- "N classmates in this course" counts without scanning every user's schedule.
CREATE TABLE IF NOT EXISTS study_group_courses (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_code TEXT NOT NULL CHECK (char_length(course_code) BETWEEN 1 AND 20),
  PRIMARY KEY (user_id, course_code)
);
CREATE INDEX IF NOT EXISTS idx_study_group_courses_code ON study_group_courses(course_code);

ALTER TABLE study_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_group_courses ENABLE ROW LEVEL SECURITY;
