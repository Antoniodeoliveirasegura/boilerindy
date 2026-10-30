-- AI suggestions opt-in: users.ai_opt_in, off by default. A student who turns
-- on "Show AI suggestions" in Settings gets the AI parts of Home (the Week
-- ahead summary and Ask AI), Tasks (priority ranking and study plan), Events
-- (event picks), Dining (What should I eat?) and the campus board (live
-- suggestions, Polish with AI, thread summaries and reply tips); everyone else
-- never sees them, and no page asks the assistant for anything on its own. The
-- Campus Assistant chat is unchanged: it sends nothing until a student asks it
-- something.
--
-- PATCH /api/me/profile sets it from { aiOptIn }, and the session payload
-- carries it as user.aiOptIn, beside analyticsOptOut from step 11.
--
-- Until this runs nothing breaks: every account reads as opted out, so the AI
-- suggestions stay hidden, and turning them on answers 503
-- ai_opt_in_schema_missing.
--
-- Idempotent and safe to re-run. Existing accounts read false; no row is written.

ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
