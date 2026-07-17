-- #132: invalidate other server sessions when a user changes their password.
--
-- getCurrentUser() rejects any session established before this timestamp, so a
-- stolen session cookie stops working the moment the real owner changes their
-- password from Settings. The column is nullable (NULL = no change recorded);
-- the server sets it to the change time via a guarded write, and treats a
-- missing column as "feature off" so the app keeps working before this runs.
--
-- Safe to run more than once.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
