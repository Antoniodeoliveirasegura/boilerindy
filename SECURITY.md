# Security

BoilerIndy is a student-built campus app. This file documents its security
posture and the rules that keep it that way. It came out of the pre-beta
security review (issue #114).

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** - do not open a public
issue with exploit details. _Owner TODO: publish a monitored security contact
email here before public launch (#114)._ Until then, open a minimal GitHub issue
asking a maintainer to get in touch, without exploit specifics.

## Data-access model

- All database access goes through the Express API using the Supabase
  **service-role** key (server-side only). The browser holds only the **anon**
  key and uses it **solely for Supabase Auth** - it never queries tables
  directly (verified: no `supabase.from(...)` calls in the frontend).
- **Row-Level Security is ENABLED on every table** (28/28) with **no policies**,
  which is _deny-all_ for the `anon`/`authenticated` roles. Because the server
  uses the service-role key (which bypasses RLS) and the client never touches
  tables, this is the intended defense-in-depth: any accidental anon-key table
  access is denied by default.
- **Do not add permissive RLS policies** (e.g. `USING (user_id = auth.uid())`)
  unless you are deliberately moving reads to the client anon key. This app
  authorizes via a server session, not Supabase Auth, so `auth.uid()` is null on
  service-role calls - such policies would only *loosen* the current deny-all
  backstop.

## Rules for contributors

1. **Every new table** must `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` in its
   SQL file (deny-all backstop). No exceptions.
2. **Every user-scoped query** must filter on `user_id` (or the owning column)
   in the API layer - RLS is bypassed by the service role, so app-code filtering
   is the real access control. A missed `.eq('user_id', …)` is a cross-user leak.
3. **Never log** tokens, session cookies, or the calendar-feed token. Sentry
   events are scrubbed in `src/sentryScrub.mjs`; keep it that way.
4. **Secrets live in env only** - never commit keys. Run `pnpm audit` before a
   release and triage new findings.

## Calendar feed (`/feeds/calendar/<token>.ics`)

- Unauthenticated **by design** (calendar clients can't send cookies) -
  authorized by a UUIDv4 capability token, the same model as Google Calendar's
  private address.
- The token is high-entropy (~122 bits), 404s on miss, is rate-limited, is never
  logged, and is regenerable from Settings (which immediately invalidates the old
  link). Users are told to treat the link like a password (privacy policy).
- Residual exposure: anyone with the link sees ~6 months of the user's events
  (titles/times/locations). Available knobs if that ever needs tightening: lower
  `FEED_HORIZON_MONTHS` (`server.mjs`) or add an opt-in auth-gated variant.

## Dependency status

- **node-ical 0.20 → 0.26 (#118)** - **DONE.** 0.26's only dependencies are
  `rrule-temporal` + `temporal-polyfill`; the upgrade dropped `axios`,
  `moment-timezone`, and `uuid` from the tree entirely. This cleared the
  **uuid `<11.1.1`** moderate advisory (GHSA-w5hq-g745-h8pq) and removed
  `form-data` along with axios - so the `>=4.0.6` override added in #114 was
  deleted from `pnpm-workspace.yaml`. 0.26 swapped recurrence handling
  (`rrule` → `rrule-temporal`), so `test/scheduleSyncParse.test.mjs` was added
  as a real-ICS-parse regression check (the pure-core tests use synthetic
  fixtures and would not catch a parser-shape change). `pnpm audit` (backend):
  **0 vulnerabilities**.
- **Frontend audit** (7× `undici`, high→low) - all transitive via
  `jsdom`/`vitest` (dev/test tooling, never shipped to the browser bundle). No
  production exposure; clear by bumping `vitest`/`jsdom` when convenient.
