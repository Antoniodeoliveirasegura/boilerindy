-- Run in Supabase SQL Editor (once). Enables the customizable home dashboard
-- (issue #52): a per-user ordered list of widgets + sizes, stored as JSONB.
-- Idempotent — safe to re-run. NULL means "use the default layout".

ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_layout JSONB;
