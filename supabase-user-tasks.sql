-- Run in Supabase SQL Editor (once). Enables Tasks page: mark imported items done + add your own dated tasks.

CREATE TABLE IF NOT EXISTS user_task_completions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_item_id UUID NOT NULL REFERENCES calendar_items(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, calendar_item_id)
);

CREATE INDEX IF NOT EXISTS idx_user_task_completions_user ON user_task_completions(user_id);

CREATE TABLE IF NOT EXISTS user_manual_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) >= 1 AND char_length(title) <= 500),
  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_manual_tasks_user_due ON user_manual_tasks(user_id, due_at);

ALTER TABLE user_task_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_manual_tasks ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_user_manual_tasks_updated_at ON user_manual_tasks;
CREATE TRIGGER update_user_manual_tasks_updated_at
  BEFORE UPDATE ON user_manual_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
