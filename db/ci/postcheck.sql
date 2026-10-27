-- CI only. scripts/check-db-apply.mjs runs this after every db/ file has been
-- applied to the scratch database, as the last step of the "db" job in
-- .github/workflows/ci.yml. It proves, on the schema as actually built, the
-- Data API lockdown the repo relies on:
--   1. every table in the public schema has row level security enabled, and
--   2. neither anon nor authenticated holds any privilege on any public table,
--      and
--   3. no policy in public is granted to anon, authenticated or public.
--
-- test/rlsCoverage.test.mjs already checks this posture by reading the SQL
-- text. This checks the built catalog, so it also catches a grant or a table
-- the text scan cannot see (a dump-style spelling, a table created by a trigger
-- or an extension, a GRANT that slipped in). Each check lists every offender
-- and raises; ON_ERROR_STOP turns that into a failed build. Read-only.
-- Never run this against a Supabase project.

do $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')          -- ordinary and partitioned tables
    and not c.relrowsecurity;
  if bad is not null then
    raise exception 'public table(s) without row level security, readable with the anon key: %', bad;
  end if;
end $$;

do $$
declare
  bad text;
begin
  select string_agg(format('%s (%s to %s)', table_name, privilege_type, grantee), ', '
           order by table_name, grantee, privilege_type) into bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated');
  if bad is not null then
    raise exception 'anon/authenticated still hold public table privileges after the lockdown: %', bad;
  end if;
end $$;

do $$
declare
  bad text;
begin
  select string_agg(format('%s on %s (%s)', policyname, tablename, roles::text), ', '
           order by tablename, policyname) into bad
  from pg_policies
  where schemaname = 'public'
    and roles && array['anon', 'authenticated', 'public']::name[];
  if bad is not null then
    raise exception 'policy(ies) in public expose the Data API roles: %', bad;
  end if;
end $$;
