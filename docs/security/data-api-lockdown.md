# Supabase Data API lockdown

## The model

BoilerIndy never lets a browser or the mobile app touch the database directly.

- The **server** (`server.mjs`) is the only client of the database. It connects
  with `SUPABASE_SERVICE_ROLE_KEY`, a secret that lives only on Render and in
  local `.env` files. That role has `BYPASSRLS`, so every row-level-security
  rule below is invisible to it.
- The **browser and the app** use Supabase only for authentication
  (`supabase.auth.*`): sign in, sign out, read the session, OAuth. They never
  call the Data API (PostgREST) and never read a table. The one key they ship is
  the **anon public key**, which is in every bundle by design and is not a
  secret.

So the attack surface the anon key opens is the Supabase **Data API**: the HTTP
endpoint at `https://<project>.supabase.co/rest/v1/<table>` that PostgREST
serves. Anyone can send the shipped anon key to it. Two independent locks keep
it from reading or writing anything:

1. **Row level security, enabled with zero policies.** Every table in the
   `public` schema has RLS on and no policy, which denies the `anon` and
   `authenticated` roles every row. A SQL-text check,
   `test/rlsCoverage.test.mjs`, fails `pnpm test` if a table ever ships without
   `ENABLE ROW LEVEL SECURITY`, or if a policy ever grants those roles access.
2. **No table privileges.** `db/supabase-anon-lockdown.sql` (README "Database
   setup" step 50) revokes all `public`-schema table and sequence privileges
   from `anon` and `authenticated`, and sets default privileges so a new object
   created by the same role is denied too. Even a table that somehow shipped
   without RLS would still be refused, because the role holds no grant on it.

The CI `db` job proves both on the schema as actually built: after it applies
every `db/` file it runs `db/ci/postcheck.sql`, which fails the build if any
`public` table lacks RLS, if `anon` or `authenticated` holds any `public` table
privilege, or if a policy names those roles.

The rate limiter is worth calling out, because it is the usual worry ("can a
student raise their own limit?"): it cannot be touched from the database at all.
Limits are constants in `server.mjs`, and the counters live in process memory
(`src/rateLimiter.mjs`), not in any table.

## Applying the lockdown

Run `db/supabase-anon-lockdown.sql` in the Supabase SQL Editor, last, after
every table-creating file in README "Database setup". Re-run it after applying
any new table file. It creates nothing, writes no rows, and is safe to re-run.

## Verifying the live project

The repo SQL shows the intent. Only the live project shows the state. Verify it
there; none of these steps change data.

### 1. Security Advisor (fastest)

Supabase dashboard, **Advisors > Security Advisor**. There must be **no
"RLS disabled in public"** finding. The informational **"RLS enabled no
policy"** line is expected and is exactly the posture above.

### 2. Table shields

Dashboard, **Database > Tables**. Every table under `public` shows the RLS
shield as **Enabled**.

### 3. SQL Editor (authoritative)

Run these three read-only queries. Each one must return **no rows**.

```sql
-- (a) Any public table without row level security:
select c.relname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

-- (b) Any public table privilege still held by the Data API roles
--     (empty once db/supabase-anon-lockdown.sql has run):
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated');

-- (c) Any policy that grants those roles access:
select schemaname, tablename, policyname, roles
from pg_policies
where schemaname = 'public'
  and roles && array['anon', 'authenticated', 'public']::name[];
```

If query (a) or (c) returns a row, that table or policy is a real exposure: fix
it before anything else. If query (b) returns rows, apply the lockdown file and
re-run it; it should then be empty.

### 4. Black-box, with the anon key (optional)

From outside, with the project's anon key (the one in the site bundle), a read
of any table must come back empty or refused, never with rows:

```bash
curl -s "https://<project>.supabase.co/rest/v1/users?select=id&limit=1" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
```

Expected: `[]` (RLS denies every row) or a `401`/`permission denied` body. A
JSON array with a row in it is a finding. This is your own endpoint and your own
key; it reads at most one row and writes nothing.
