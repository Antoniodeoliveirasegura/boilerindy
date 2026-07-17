# BoilerIndy Security Audit — 2026-07-16

Read-only, multi-agent security review. Seven parallel reviewers (auth, access-control,
SSRF, injection, secrets, frontend, rate-limiting/deps) produced findings; every CRITICAL
and HIGH finding was then handed to an independent adversarial verifier prompted to *refute*
it. Refuted findings were dropped; three findings were honestly downgraded. This is an
investigation — nothing was changed. The maintainer decides what to fix.

## Summary

| Severity | Count | Confirmed items |
|---|---|---|
| **CRITICAL** | 2 | SSRF redirect-bypass, SSRF IPv4-mapped-IPv6 bypass |
| **HIGH** | 5 | Email-change account takeover; feed-token → Sentry; Gemini key → Sentry; DNS-rebinding SSRF; warn-only host allowlist |
| **MEDIUM** | 14 | `isProduction` fail-open, no rate-limit on password re-auth, advertiser reset-token logged, raw DB errors to clients, no catch-all error handler, session not invalidated on password change, Purdue-mode denylist, auth-config redirect landmine, MemoryStore in prod, Supabase JWT in localStorage, unpkg Leaflet (no SRI), missing CSP, hardcoded TransLoc key, single prod/dev Supabase project |
| **LOW** | 9 | `.or()` filter injection, open-redirect `//host`, no max password length, marketplace ILIKE wildcards, lost-found existence oracle, no absolute session cap, SESSION_SECRET strength, admin raw DB error, ad-hoc Gemini limiter |
| **Deps** | — | Backend: **0** advisories. Frontend: 7 advisories, **all dev-only** (undici via jsdom/vitest), not in the production bundle |

### Top three to fix first

1. **SSRF in schedule-sync (both CRITICALs + both SSRF HIGHs are one subsystem).** Any
   self-registered user can make the server fetch internal/cloud-metadata endpoints and read
   the response back. Two independent bypasses of `assertSafeHttpUrl`, plus DNS-rebinding,
   plus a "hard" allowlist that only `console.warn`s. Fix `src/urlSafety.mjs` **and** pin the
   fetch (redirect handling + IP pinning) in `runScheduleSync`.
2. **Email-change account takeover (`PATCH /api/me/profile`).** A stolen session cookie
   becomes a *permanent* password-based takeover because email can be changed with no
   password re-auth and no notice to the old address. Require `currentPassword` for email
   changes, notify the old address, and rate-limit the route.
3. **Secret leakage to Sentry.** The scrubber misses the live `GEMINI_API_KEY` (in a fetch
   URL → breadcrumb) and the calendar-feed bearer token (a UUID in `request.url`) — the
   latter directly violating the code's own "is never logged" comment. Fix `src/sentryScrub.mjs`
   and move the Gemini key out of the URL into a header.

A cross-cutting note: the **`isProduction` fail-open default** (MEDIUM #1) is a threat
multiplier — if `NODE_ENV` is ever wrong on the host, it simultaneously un-gates the debug
SSRF endpoint, drops the `Secure` cookie flag, collapses all rate-limit buckets into one, and
re-enables the mock Purdue-auth bypass. Assert it at boot.

---

## CRITICAL

### C1 — SSRF: validated URL is fetched with redirect-follow, so a public URL 302s to internal targets
- **Severity:** CRITICAL · **Verifier verdict: CONFIRMED** (reproduced live: a `fetch(url)` with no options transparently followed a 302 to a second host with zero re-validation between).
- **Location:** `server.mjs:688-689` and `server.mjs:1423-1424` (`assertSafeHttpUrl` called once, return value discarded, then `ical.async.fromURL(source.source_url)`); root cause `node_modules/node-ical/node-ical.js:113-146` (`fetch(url, {})`, no `redirect` override → undici default `follow`).
- **Failure scenario:** Attacker self-registers (open registration, any email — `server.mjs:976-1054`), then `POST /api/sources/brightspace/schedule` (`requireAuth` only) with a public URL they control, e.g. `https://attacker.example/x.ics`. `assertSafeHttpUrl` passes it (public IP). Their server replies `302 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>` (or `http://127.0.0.1:6379/`, or any internal IP:port). The redirect is followed unvalidated; if the target is iCal-shaped the `SUMMARY`/`DESCRIPTION` land in `calendar_items` and are read back via `GET /api/me/calendar`. Readable SSRF, not blind.
- **Fix:** Fetch with `redirect: 'manual'`, re-run `assertSafeHttpUrl` on each `Location` (cap hops to ~3-5), or fetch the body yourself with an undici `Agent` whose `connect`/`lookup` is pinned to the already-validated IP and `maxRedirections: 0`, then hand the text to `ical.parseICS`. This closes C1 and H4 together.

### C2 — SSRF: `isBlockedIp` doesn't unwrap IPv4-mapped IPv6, so `::ffff:127.0.0.1` / `::ffff:169.254.169.254` pass
- **Severity:** CRITICAL · **Verifier verdict: CONFIRMED** (reproduced live against the real `assertSafeHttpUrl`: both `http://[::ffff:127.0.0.1]/` and `http://[::ffff:169.254.169.254]/...` returned ALLOWED, and a real socket to `[::ffff:127.0.0.1]` hit the loopback listener).
- **Location:** `src/urlSafety.mjs:15-21` — the IPv6 branch checks only `=== '::1'`, `startsWith('fc'|'fd')`, `startsWith('fe80')` and returns `false` for everything else. No `::ffff:a.b.c.d` handling. Reached from both the literal-IP path and the DNS-resolution path (`urlSafety.mjs:50-55`), so an attacker-registered domain with an `AAAA` of `::ffff:127.0.0.1` bypasses too.
- **Failure scenario:** Same reachability as C1. `POST /api/sources/brightspace/schedule` with `{"icsUrl":"http://[::ffff:169.254.169.254]/latest/meta-data/iam/security-credentials/..."}` — no redirect needed; direct single-request SSRF to cloud metadata or any RFC1918 host.
- **Fix:** In `isBlockedIp`, detect/unwrap IPv4-mapped IPv6 (`::ffff:x.x.x.x`, and the deprecated `::x.x.x.x`) and re-run the IPv4 checks on the embedded address; widen the link-local test to the full `fe80::/10`. Prefer a vetted library (`ipaddr.js` `.range()`/`.isIPv4MappedAddress()`) over hand-rolled prefix checks. Add regression tests for `::ffff:127.0.0.1`, `::ffff:169.254.169.254`, and a redirect-to-internal case (`test/urlSafety.test.mjs` currently has zero IPv6/redirect coverage).

---

## HIGH

### H1 — Account takeover: email changed with no re-authentication and no notice
- **Severity:** HIGH (borderline CRITICAL) · **Verifier verdict: CONFIRMED** (all five refutation angles failed).
- **Location:** `server.mjs:365-406` (`updateUserProfile`) + route `server.mjs:1376` (`PATCH /api/me/profile`, `requireAuth` only, **no rate limit**). Password check (`applyPasswordChange`) runs only when `newPassword` is set; the email-sync block calling `supabase.auth.admin.updateUserById(userId, { email, email_confirm: true })` is *outside* that guard.
- **Failure scenario:** Attacker holding a stolen `pih.sid` (via XSS, log/proxy leak, device access, or session fixation — *not* plain CSRF, which `sameSite:lax` blocks) sends `PATCH /api/me/profile` with body `{"email":"attacker@evil.com"}`. The Admin API (service-role) marks the new address confirmed immediately — no click-to-verify, no dual confirmation, no email to the old address (grep confirms zero email-change notifications exist). Attacker then runs Supabase `resetPasswordForEmail` on the new address and sets a password, converting a transient session theft into durable, cookie-independent ownership of the account (grades, schedule, connections). No rate limit on this route also enables `currentPassword` brute-force.
- **Fix:** Require `currentPassword` verification whenever `email` changes (reuse the existing `applyPasswordChange`/`verifySupabasePassword` path), send a notice to the *old* address on any email change, don't pass `email_confirm: true` for user-initiated changes (make the new address confirm first), and add `signInRateLimit` to the route (matches the sibling `/api/me/delete-account`).

### H2 — Calendar-feed bearer token leaks to Sentry via `request.url` (violates the code's own "never logged" invariant)
- **Severity:** HIGH · **Verifier verdict: CONFIRMED** (traced the installed `@sentry/*@10.57` source: `requestDataIntegration` hardcodes `url: true`; `getSanitizedUrlString` strips query/userinfo but never path segments; the scrubber's `HEX_TOKEN_RE` requires 32+ *contiguous* hex, which a hyphenated UUID structurally can never satisfy).
- **Location:** `src/sentryScrub.mjs:11` (`HEX_TOKEN_RE`); leak field `event.request.url`; route `server.mjs:2016-2086` (feed) with `console.error` at `:2057` caught by `captureConsoleIntegration`; comment asserting "never logged" at `server.mjs:1987-1989`.
- **Failure scenario:** `SENTRY_DSN` is set (documented expected prod var per `.env.example`) and any Sentry event fires while handling `GET /feeds/calendar/<token>.ics` (e.g. the route's own `console.error` on a transient Supabase read failure). `event.request.url` = `/feeds/calendar/<uuid>.ics`, unredacted, shipped to Sentry. Anyone with Sentry project access gets a live, until-regenerated calendar bearer link (rated "High" sensitivity in `INCIDENT-RESPONSE.md`).
- **Fix:** Add a UUID pattern to the scrub set (`/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi`), and specifically strip everything after `/feeds/calendar/` in `event.request.url`. Add a regression test with a UUID.

### H3 — Live `GEMINI_API_KEY` leaks to Sentry via outbound-fetch breadcrumb query string
- **Severity:** HIGH · **Verifier verdict: CONFIRMED** (traced SDK: `nativeNodeFetchIntegration` runs unconditionally — *not* gated by `tracesSampleRate:0` — and `outgoingFetchRequest.js` re-attaches the raw query string as `data['http.query']` after sanitizing the `url` field; `sendDefaultPii:false` does not cover this).
- **Location:** `src/sentryScrub.mjs:7-11` (regexes miss Google `AIzaSy...` keys — not JWT/Bearer/32-hex/email); trigger sites `server.mjs:2636/2952/3012` (`fetch(\`${GEMINI_API_URL}?key=${GEMINI_API_KEY}\`)`).
- **Failure scenario:** `SENTRY_DSN` set and any Gemini call fails (rate limit / malformed response / timeout). The call sites' own `console.error` catch (`server.mjs:2648`) fires → `captureConsoleIntegration` ships an event whose breadcrumb trail contains `?key=AIzaSy...` in cleartext. (The TransLoc key in the same pattern is already a hardcoded public value — see MEDIUM #13 — so only the Gemini key is a real secret leak here.)
- **Fix:** Move the Gemini key to a header (`x-goog-api-key`) instead of the URL, and add a `beforeBreadcrumb`/`beforeSend` step that strips `key|apiKey|api_key|token|access_token` query params from any captured URL. Extend `sentryScrub.mjs` to sanitize URL query strings generically.

### H4 — SSRF: DNS rebinding — validate-time resolution differs from fetch-time resolution, no IP pinning
- **Severity:** HIGH · **Verifier verdict: CONFIRMED** (structural TOCTOU; not force-reproduced end-to-end since it needs attacker-controlled authoritative DNS, but the gap is unambiguous).
- **Location:** `src/urlSafety.mjs:50` (`dns.lookup(hostname, {all:true})` at validation) vs `server.mjs:688-689/1423-1424` (undici resolves the hostname again at connect time; `assertSafeHttpUrl`'s result isn't even passed to the fetch — the raw `source_url` string is reused). `POST /api/sync/:sourceId` (`requireAuth`) gives on-demand repeat cycles bounded only by the 30/15-min limiter.
- **Failure scenario:** Attacker points a domain at a low/zero-TTL record that answers public on the validation lookup and internal (`169.254.169.254`, RFC1918) on the fetch lookup.
- **Fix:** Resolve once, validate, then connect to the pinned IP (undici `Agent` custom `lookup`/`connect`) while keeping the original `Host` header — same fix as C1's pinning.

### H5 — SSRF: the Purdue/Brightspace host "allowlist" only warns, never blocks
- **Severity:** HIGH · **Verifier verdict: CONFIRMED** (neither branch `return`s/`throw`s — execution falls through into `runScheduleSync` regardless of host).
- **Location:** `server.mjs:1501-1505` (Purdue) and `server.mjs:1538-1543` (Brightspace — comment literally says "Still allow it but log the warning"). The Brightspace route needs only `requireAuth`, so `assertSafeHttpUrl` (shown broken above) is the *entire* defense for a feature that only ever needs `*.purdue.edu` / `*.brightspace.com`.
- **Fix:** Convert to a hard suffix-match allowlist returning `400` on non-matching hosts, as defense-in-depth *in addition to* the `urlSafety.mjs` fixes.

---

## MEDIUM

These come from the expert reviewers and are reported as-is (the adversarial verify pass
covered CRITICAL/HIGH only). FE-1 and FE-2 were verified and downgraded from HIGH.

| # | Title | Location | Why it matters / fix |
|---|---|---|---|
| M1 | `isProduction` fails open; no boot assertion | `server.mjs:118` (consumed `:139,:165-178,:201,:1413`) | If `NODE_ENV` is unset/mistyped in prod, it simultaneously un-gates the debug SSRF endpoint, drops `Secure` on the session cookie, skips `trust proxy` (collapsing all anon rate-limit buckets into one), and skips the mock-Purdue guard. Assert a known value at boot or invert to fail-closed; log resolved value. |
| M2 | No rate limit on `PATCH /api/me/profile` | `server.mjs:1376` | Enables `currentPassword` brute-force and unbounded email-change abuse (compounds H1). Add `signInRateLimit` like `/api/me/delete-account`. |
| M3 | Advertiser reset link + email logged in cleartext, no prod guard | `server.mjs:4319-4321`, `src/email.mjs:28-32` | If `RESEND_API_KEY`/`RESEND_FROM` are ever unset in prod, every forgot-password writes a live 1-hour reset token + email to logs (→ HIGH in that state). Gate behind `!isProduction`; fail closed (503) in prod. |
| M4 | Advertiser API returns raw Postgres error strings to unauthenticated callers | `server.mjs:4131-4143` (via `/api/advertiser/sign-in`, `/forgot-password`, `/reset-password`) | Inconsistent with the six other sanitized DB-error handlers. Leaks table/column/constraint names pre-auth. Return a generic message; log detail server-side only. |
| M5 | No catch-all Express error middleware | `server.mjs` (none after `setupExpressErrorHandler` at `:4913`) | Malformed JSON to any route throws `SyntaxError` → Express `finalhandler` renders a full stack trace whenever `NODE_ENV !== 'production'`. Add a final `(err,req,res,next)` returning generic JSON regardless of env. |
| M6 | Password change doesn't invalidate other sessions | `server.mjs:365-428`, `:4340-4369` | MemoryStore isn't indexed by user, so "change password" doesn't evict a stolen session. Add a `password_changed_at`/session-version check in `getCurrentUser`. |
| M7 | `PURDUE_AUTH_MODE` guard is a denylist (`!== 'mock'`), not an allowlist | `server.mjs:125,174-177,1302-1352` | A mistyped mode that isn't exactly `'mock'` passes startup but reactivates the unauthenticated self-assert-Purdue-email bypass → identity squatting. Change to `if (isProduction && !['cas','off'].includes(mode)) exit(1)`. |
| M8 | `authApi.ts` 401-redirect exclusion misses `/api/auth-config` | `boilerindy-react/src/lib/authApi.ts:33`; `AuthContext.tsx:155,170` | Dormant today (endpoint always 200s), but if a guard is ever added to `/api/auth-config` it becomes an unrecoverable full-app redirect loop for every visitor. Replace substring blocklist with an explicit allowlist; skip redirect when already on `/login`. |
| M9 | Production session store is in-process `MemoryStore` | `server.mjs:189-205` | Memory growth on long uptime + can't scale horizontally. Document as a conscious single-instance trade-off; plan a Postgres/Redis store before multi-instance. |
| M10 | Supabase access+refresh JWTs persisted in `localStorage` | `boilerindy-react/src/lib/supabase.ts:12-23` (SDK default) | XSS-readable refreshable credential, larger blast radius than the httpOnly cookie. Largely inherent to supabase-js; document as accepted risk or pass an in-memory `storage` adapter. The CSP (M12) reduces the XSS that would read it. |
| M11 | Runtime unpkg Leaflet injection, no SRI (downgraded from HIGH) | `boilerindy-react/src/pages/Transit.tsx:173-190` | **Verified**; downgraded because it needs unpkg's CDN to be compromised (not attacker-triggerable). Also wasteful — `leaflet`/`react-leaflet` are already bundled deps used correctly in `Map.tsx`. Fix: use the bundled `import`, delete the CDN injection. |
| M12 | No Content-Security-Policy anywhere (downgraded from HIGH) | `boilerindy-react/vercel.json`, `index.html`, `server.mjs` | **Verified absent.** Downgraded to defense-in-depth — but the verifier found a real adjacent sink: `Transit.tsx:307-312,397-406` interpolate unescaped TransLoc feed fields into raw HTML via Leaflet `.bindPopup()` (a DOM-XSS sink a `dangerouslySetInnerHTML` grep misses). Add the CSP below **and** escape those popup values. |
| M13 | Hardcoded TransLoc API key fallback in source | `server.mjs:2677` | Checked-in credential (public transit data, low impact) but flagged by any secret scanner and can't rotate without a deploy. Remove the `|| '8882…'` fallback; require the env var, fail closed like Gemini. |
| M14 | Single Supabase project for dev + prod; service-role key in local `.env` | `.env` (untracked — confirmed never committed) | Any dev-machine compromise = full prod DB compromise (service-role bypasses RLS, which has no policies). Operational: provision a separate dev project; verify prod `SESSION_SECRET` differs from the placeholder in local `.env`. |

**Proposed CSP for M12** (built from origins actually used — set as headers in `vercel.json`):
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: https:; font-src 'self';
connect-src 'self' https://*.supabase.co https://services1.arcgis.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io;
frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
```
(Extract the inline theme script in `index.html` to `/theme-init.js` so `script-src 'self'` needs no exception; fixing M11 keeps `script-src`/`style-src` off `unpkg.com`. Add `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` alongside.)

---

## LOW

| # | Title | Location | Note |
|---|---|---|---|
| L1 | `.or()` filter injection in lost-found search (downgraded from HIGH) | `server.mjs:2116,2127` | **Verified** real PostgREST injection primitive, but confined to the same table's already-`SELECT *`-exposed columns (incl. `contact`, which a no-`q` request already returns to any authed user); can't cross tables (no embed) or bypass the `deleted_at` AND-filter. Fix as defense-in-depth: escape `,`.`()%` before interpolating, or use `.textSearch()`. |
| L2 | Open-redirect guard accepts protocol-relative `//host` | `server.mjs:315-318`, `authApi.ts:92-97` | Inert today (call sites prefix an origin / use React Router), but reject `//` and `\` directly. |
| L3 | No maximum password length before scrypt | `server.mjs:987`, `src/advertiserAuth.mjs:78`, `src/advertiserPasswordReset.mjs:69`, `src/studentPasswordAuth.mjs:63` | scrypt runs on the full input (bounded only by 100 kB body). Add a 128-char cap. |
| L4 | Marketplace ILIKE wildcard injection | `server.mjs:3729,3741` | `%`/`_` unescaped — search-behavior only, not an authz/data bypass. Optional. |
| L5 | Lost-found edit existence oracle (403 vs 404) | `server.mjs:2169-2184` | Not exploitable (board is public-read); the mutation is correctly blocked. Optional uniform 404. |
| L6 | No absolute session lifetime cap / per-user revocation | `server.mjs:189-205` | `rolling:true` slides indefinitely; only site-wide `SESSION_SECRET` rotation force-logs-out. Ties to M6. |
| L7 | `SESSION_SECRET` strength not enforced | `server.mjs:162-177` | Presence checked, not length. Enforce ≥32 chars at boot. |
| L8 | Admin `purdue-links/clear` returns raw DB error | `server.mjs:4774-4776` | Authenticated-admin only; low impact. Route through the sanitized convention. |
| L9 | Gemini limiter is ad-hoc, bypasses the kill switch, doc is stale | `server.mjs:2307-2324`; `docs/RATE_LIMITS.md:21-22` | Both AI endpoints *are* throttled (10/hr/user) but ignore `RATE_LIMIT_ENABLED`, share one budget, and emit no standard headers; doc says 20/hr. Migrate to `createRateLimiter`; fix the doc. |

---

## Good posture (verified solid)

The audit found a lot that is genuinely well-built — worth stating so the report is honest.

- **Access control is systematically correct.** All ~118 routes were enumerated; every
  user-scoped read/write filters on the session-derived id (`req.currentUser.id` /
  `req.currentAdvertiser.id`), never a client-supplied id. Update/delete handlers carry
  `.eq('user_id', …)`. The one body-supplied `userId` sink is an admin route behind
  `requireAdmin`. No IDOR/BOLA found — the dimension the threat model called #1 is clean.
- **Student ↔ advertiser session isolation** is real (distinct session keys, each sign-in
  `regenerate()`s and wipes the other role; neither key is read outside its own guard).
- **No session fixation** — every login path calls `req.session.regenerate()` before setting
  identity. Cookie flags are correct (`httpOnly`, `sameSite:lax`, `secure` in prod, non-default
  `pih.sid`). Same-origin proxy design means no CORS surface at all.
- **`/api/auth/supabase-sync` doesn't trust client identity** — it re-validates the bearer
  token via `supabase.auth.getUser()` and 401s on any mismatch. Purdue CAS validation is a
  real HTTP round-trip, and `PURDUE_AUTH_MODE=mock` is hard-blocked at prod startup.
- **Password handling** — constant-time `timingSafeEqual`; advertiser sign-in compares a dummy
  hash for unknown emails (enumeration-resistant); reset tokens are 32-byte, SHA-256-hashed,
  single-use, 1-hour, and all burned on success.
- **Injection surface is small** — zero raw SQL / `.rpc()`; validators build fresh allowlisted
  objects (no `{...req.body}` spread → no prototype-pollution write path, `hasOwnProperty.call`
  used); no `exec`/`spawn` in the request path; admin soft-delete resolves `type` through a
  hardcoded 5-table allowlist. The `.ics` feed RFC-5545-escapes all TEXT fields.
- **Frontend** — zero `dangerouslySetInnerHTML`; all `target="_blank"` carry `rel="noopener"`;
  `linkifyText` only emits `https?://` anchors; no `eval`/`new Function`; Gemini is never called
  from the browser (only the `requireAuth`-gated `/api/assistant`).
- **Secrets** — `.env`/`.env.*` never committed (only placeholder `.env.example`); no
  `VITE_`-prefixed secret; service-role key is server-only; `password_hash`/`is_admin`/feed
  token never spread into client responses (curated projections, asserted by a unit test);
  cross-user PII is deliberately minimized (display names only pre-connection).
- **Rate limiting & feed** — sign-in, both advertiser flows, password reset, all three
  schedule-sync routes, account creation, and the calendar feed are all limited; `trust proxy`
  is correctly `1` (not `true`); the feed returns a uniform 404 (no enumeration oracle) with a
  122-bit token and a DB-level unique index so one token can't resolve to two users.
- **`assertSafeHttpUrl`, despite the bypasses above,** correctly blocks non-http(s) schemes,
  standard IPv4 private/loopback/link-local ranges (incl. plain `169.254.169.254`), plain-form
  IPv6 loopback/ULA/link-local, `localhost`/`.local`/`.internal`, checks *all* resolved
  addresses, and normalizes decimal/octal/hex IPv4 encodings via the WHATWG URL parser.
- **Dependencies** — backend `pnpm audit`: **0 vulnerabilities**. Frontend's 7 advisories are
  all transitive `undici` via `jsdom`/`vitest` (devDependencies), never in the Vite prod bundle.

---

## Method & scope

- Seven read-only reviewers ran in parallel over `server.mjs`, `src/*.mjs`, `boilerindy-react/`,
  `db/*.sql`, and full git history. No files were modified.
- Every CRITICAL/HIGH finding got one adversarial verifier prompted to refute it by tracing the
  real code path (several reproduced exploits live in isolated loopback-only Node processes, and
  read the installed `@sentry/*` / `@supabase/postgrest-js` / `node-ical` source directly rather
  than reasoning from docs). Nothing was refuted outright; L1, M11, M12 were downgraded.
- Not covered (candidates for a deeper pass): live runtime/deployment config on Render
  (whether `NODE_ENV`/`SENTRY_DSN` are actually set), the Playwright-driven Purdue automation's
  own attack surface, business-logic abuse (e.g. marketplace/board spam economics), and a
  full dynamic DAST run against a staging instance.
