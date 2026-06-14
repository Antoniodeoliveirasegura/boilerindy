-- Run in Supabase SQL Editor (once). Enables the Grade Tracker page (issue #10):
-- per-user courses with credit hours + letter grades, grouped by term, for GPA.

CREATE TABLE IF NOT EXISTS user_grades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_name TEXT NOT NULL CHECK (char_length(course_name) >= 1 AND char_length(course_name) <= 120),
  term TEXT NOT NULL DEFAULT 'Other' CHECK (char_length(term) <= 60),
  credit_hours NUMERIC(4,2) NOT NULL DEFAULT 3 CHECK (credit_hours >= 0 AND credit_hours <= 30),
  letter_grade TEXT NOT NULL CHECK (char_length(letter_grade) <= 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_grades_user ON user_grades(user_id);

ALTER TABLE user_grades ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_user_grades_updated_at ON user_grades;
CREATE TRIGGER update_user_grades_updated_at
  BEFORE UPDATE ON user_grades
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
