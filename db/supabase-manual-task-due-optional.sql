-- Manual tasks: make the due date optional.
--
-- user_manual_tasks.due_at was created NOT NULL, so every task had to carry a deadline.
-- The mobile client creates plain undated to-dos (a title and nothing else), which the
-- POST /api/me/tasks/manual handler had to reject with a 400. Dropping the constraint
-- lets an undated task exist; the web client keeps sending a due date and is unaffected.
--
-- Postgres sorts NULLs last for ASC by default, so the existing
-- `.order('due_at', { ascending: true })` read path puts undated tasks after dated ones
-- without any query change.
--
-- Safe to re-run: DROP NOT NULL on a column that is already nullable is a no-op.

ALTER TABLE user_manual_tasks ALTER COLUMN due_at DROP NOT NULL;
