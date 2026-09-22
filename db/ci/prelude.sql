-- CI only. scripts/check-db-apply.mjs runs this before the db/ files, on the
-- stock postgres:15 service container that the "db" job in
-- .github/workflows/ci.yml starts. It stands in for what a Supabase project has
-- out of the box and a plain Postgres does not: the three API roles that the
-- GRANT and REVOKE statements name, the auth schema, and the cron and net
-- schemas that the pg_cron and pg_net extensions normally create. The two
-- "create extension" lines in db/supabase-keep-warm.sql are the only statements
-- the script skips (those extensions are not in the stock image); the
-- cron.schedule() below stores the job the way the real one does, so that file
-- still has to parse and run. Never run this against a Supabase project.

-- Roles are cluster-wide, so a second run on the same server (a local replay)
-- must not trip over the first one; Postgres has no "create role if not exists".
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema if not exists extensions;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
  language sql stable as $$ select null::uuid $$;

create schema if not exists cron;
create table cron.job (
  jobid bigserial primary key,
  jobname text unique,
  schedule text not null,
  command text not null,
  active boolean not null default true
);
create table cron.job_run_details (
  jobid bigint,
  status text,
  return_message text,
  start_time timestamptz
);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint
  language plpgsql as $$
declare id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
    returning jobid into id;
  return id;
end $$;
create or replace function cron.unschedule(job_name text) returns boolean
  language plpgsql as $$
begin
  delete from cron.job where jobname = job_name;
  return found;
end $$;

create schema if not exists net;
create or replace function net.http_get(
  url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000
) returns bigint language sql as $$ select 1::bigint $$;
create or replace function net.http_post(
  url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000
) returns bigint language sql as $$ select 1::bigint $$;
