# Security

BoilerIndy is a student-built campus app. This file documents its security
posture and the rules that keep it that way. It came out of the pre-beta
security review (issue #114).

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** to **security@boilerindy.app**
- do not open a public issue with exploit details. If you prefer, open a minimal
GitHub issue asking a maintainer to get in touch (without exploit specifics), and
we will follow up privately.

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
   (Audited 2026-08-09 for #114: all ~145 `supabase.from(...)` queries in
   `server.mjs` were verified to constrain to the current principal - zero IDOR.)
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

## Marketplace seller contact (`GET /api/marketplace/:id`)

- Returns the seller's name and Purdue email to any signed-in student - the
  intended buyer-to-seller contact path. Not an IDOR: the endpoint is auth-gated
  and the id comes from the listing row, not raw user input.
- Residual exposure: listing ids are enumerable, so a signed-in user could sweep
  the detail endpoint to harvest seller emails. `marketplace-read` (`server.mjs`,
  100 / 15 min per user) throttles that from a bulk scrape to a slow trickle.
  Revisit with an in-app contact relay if harvesting is ever observed (#114).

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

## Known operational risks (accepted)

Tracked for a conscious decision rather than fixed in code (see the 2026-07-16
security audit `security-audit-2026-07-16.md` and issue #135):

- **In-process session store.** `express-session` uses the default `MemoryStore`.
  Fine for the current single Render instance, but it grows in memory over long
  uptimes and can't be shared across instances - move to a Postgres/Redis-backed
  store before any horizontal scale.
- **Supabase tokens in `localStorage`.** `@supabase/supabase-js` stores its
  access/refresh JWTs in `localStorage` by default (XSS-readable). Largely inherent
  to the SDK; the CSP in `boilerindy-react/vercel.json` reduces the XSS that would
  read them. Revisit with an in-memory storage adapter if the posture needs it.
- **Shared dev/prod Supabase project.** Local dev and production use the same
  Supabase project + service-role key, so a compromised dev machine equals prod DB
  compromise. Provision a separate dev project, and keep the production
  `SESSION_SECRET` distinct from any value in a local `.env`.
