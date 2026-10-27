-- Run in Supabase SQL Editor (once; safe to re-run). Data API lockdown: take
-- away the public-schema privileges Supabase grants the anon and authenticated
-- roles by default, so the Data API (PostgREST, the HTTP endpoint reachable
-- with the anon key shipped in every browser and app bundle) can read and write
-- nothing in public. Needs db/supabase-schema.sql (step 1); meant to run last,
-- after every table-creating file above. Creates nothing and writes no rows.
--
-- Why this exists on top of RLS. The server talks to Supabase with
-- SUPABASE_SERVICE_ROLE_KEY, which has BYPASSRLS, so none of this touches the
-- server's own queries. The browser and the app only ever call Supabase Auth
-- (supabase.auth.*), never the Data API, so no feature reads a table or calls
-- an RPC as anon or authenticated. Every table already ships with row level
-- security enabled and zero policies (test/rlsCoverage.test.mjs), which denies
-- those roles every row. This file adds a second, independent lock underneath:
-- it removes the table and sequence privileges themselves, so a table that ever
-- ships without RLS by mistake is still unreadable through the Data API. RLS on
-- and no grant: either one alone denies anon; the repo keeps both.
--
-- Scope is the public schema only. The auth, storage and realtime schemas keep
-- their Supabase-managed grants; marketplace photo uploads go through signed
-- Storage URLs, which this does not touch. Function EXECUTE is handled per
-- function in the files that define them (see supabase-atomic-counters.sql,
-- supabase-calendar-category-counts.sql and supabase-study-group-join.sql).
--
-- The ALTER DEFAULT PRIVILEGES lines cover objects created later by the role
-- that runs this file (postgres, in the SQL Editor). A table added through the
-- dashboard table editor can be created by a different role, so re-run this
-- file after applying any new table file. db/ci/postcheck.sql fails the build
-- if a public table ever ends up reachable by anon or authenticated.

REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Future objects created by the current role: deny the same roles up front, so
-- a new table is locked the moment it is created, not only on the next re-run.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
