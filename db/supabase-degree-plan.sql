-- Run in Supabase SQL Editor (once). Adds the user's selected major for the
-- degree planner (issue #18). The value is a degreePrograms.mjs program id
-- (e.g. 'computer-science') or NULL; the app validates it against the catalogue.

ALTER TABLE users ADD COLUMN IF NOT EXISTS major TEXT;
