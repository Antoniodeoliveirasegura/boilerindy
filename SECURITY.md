# Security

BoilerIndy is a student-built campus app. This file documents its security
posture and the rules that keep it that way. It came out of the pre-beta
security review (issue #114).

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue with exploit details. _Owner TODO: publish a monitored security contact
email here before public launch (#114)._ Until then, open a minimal GitHub issue
asking a maintainer to get in touch, without exploit specifics.

## Data-access model

- All database access goes through the Express API using the Supabase
  **service-role** key (server-side only). The browser holds only the **anon**
  key and uses it **solely for Supabase Auth** — it never queries tables
  directly (verified: no `supabase.from(...)` calls in the frontend).
- **Row-Level Security is ENABLED on every table** (28/28) with **no policies**,
  which is _deny-all_ for the `anon`/`authenticated` roles. Because the server
  uses the service-role key (which bypasses RLS) and the client never touches
  tables, this is the intended defense-in-depth: any accidental anon-key table
  access is denied by default.
- **Do not add permissive RLS policies** (e.g. `USING (user_id = auth.uid())`)
  unless you are deliberately moving reads to the client anon key. This app
  authorizes via a server session, not Supabase Auth, so `auth.uid()` is null on
  service-role calls — such policies would only *loosen* the current deny-all
  backstop.

## Rules for contributors

1. **Every new table** must `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` in its
   SQL file (deny-all backstop). No exceptions.
2. **Every user-scoped query** must filter on `user_id` (or the owning column)
   in the API layer — RLS is bypassed by the service role, so app-code filtering
   is the real access control. A missed `.eq('user_id', …)` is a cross-user leak.
3. **Never log** tokens, session cookies, or the calendar-feed token. Sentry
   events are scrubbed in `src/sentryScrub.mjs`; keep it that way.
4. **Secrets live in env only** — never commit keys. Run `pnpm audit` before a
   release and triage new findings.

## Calendar feed (`/feeds/calendar/<token>.ics`)

- Unauthenticated **by design** (calendar clients can't send cookies) —
  authorized by a UUIDv4 capability token, the same model as Google Calendar's
  private address.
- The token is high-entropy (~122 bits), 404s on miss, is rate-limited, is never
  logged, and is regenerable from Settings (which immediately invalidates the old
  link). Users are told to treat the link like a password (privacy policy).
- Residual exposure: anyone with the link sees ~6 months of the user's events
  (titles/times/locations). Available knobs if that ever needs tightening: lower
  `FEED_HORIZON_MONTHS` (`server.mjs`) or add an opt-in auth-gated variant.

## Dependency status (as of the #114 review)

- **form-data** (high — CRLF injection) — **FIXED** via a `>=4.0.6` override in
  `pnpm-workspace.yaml`. Pulled transitively through `node-ical > axios`;
  non-exploitable in our GET-only usage, but patched anyway.
- **uuid `<11.1.1`** (moderate) — transitive via `node-ical` (uses uuid@10).
  Non-exploitable: the advisory needs a `buf` argument that node-ical never
  passes. Resolved by upgrading **node-ical 0.20 → 0.26+**, which drops
  axios/uuid/form-data entirely. **Deferred to its own task**: 0.26 switched
  recurrence handling (`rrule` → `rrule-temporal`), which
  `src/scheduleSync.mjs::expandRecurringEvents` depends on, so it needs a real
  ICS-parse regression check — the unit tests use synthetic fixtures and would
  not catch a parser-shape change.
- **Frontend audit** (7× `undici`, high→low) — all transitive via
  `jsdom`/`vitest` (dev/test tooling, never shipped to the browser bundle). No
  production exposure; clear by bumping `vitest`/`jsdom` when convenient.
