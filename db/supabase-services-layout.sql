-- Run in Supabase SQL Editor (once). Enables the customizable Student Services
-- board: a per-user ordered list of widgets (In-App Shortcuts + resource groups)
-- with sizes + visibility, stored as JSONB. Mirrors supabase-dashboard-layout.sql.
-- Idempotent — safe to re-run. NULL means "use the default layout".

ALTER TABLE users ADD COLUMN IF NOT EXISTS services_layout JSONB;
