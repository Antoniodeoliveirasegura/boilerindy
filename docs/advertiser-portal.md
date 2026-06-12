# Advertiser Portal — Scope & Architecture

Status: **Login UI shipped (stubbed); backend not started.**
Last updated: 2026-06-12

The advertiser portal lets local businesses/marketers run ads inside BoilerIndy,
separate from the student app. The marketing front page (`/`) and the advertiser
sign-in (`/advertise`) ship as UI; this doc specifies the backend and the path to
real, served ads.

---

## 1. Current state

| Piece | Where | State |
|---|---|---|
| Marketing front page | `boilerindy-react/src/pages/Landing.jsx` | Live at `/` |
| Advertiser sign-in | `boilerindy-react/src/pages/AdvertiserLogin.jsx` | **UI only** — `handleSubmit` is stubbed (validates + shows invite-only notice). No auth, no session. |
| `/demo` | `App.jsx` | Redirects to `/advertise` |
| "Request advertiser access" | `AdvertiserLogin.jsx` | `mailto:` link — not stored anywhere |
| Profile dropdown entry | `components/Navbar.jsx` | "Advertiser portal" → `/advertise` |

The student app's auth is the template to mirror (but **not** entangle):
- Express session cookie `pih.sid`; `req.session.userId` identifies the principal.
- `requireAuth` (server.mjs ~L427) → `getCurrentUser` → `getUserById(req.session.userId)`.
- Sign-in (`POST /api/auth/sign-in`, ~L912) regenerates the session, sets `userId`.
- Server uses a single service-role Supabase client (`supabase`, server-side only).
- Migrations are plain `.sql` files run once in the Supabase SQL editor
  (e.g. `supabase-dashboard-layout.sql`).

---

## 2. Design principles

1. **Isolation.** Advertisers must never reach student data. Use a *separate*
   session key (`req.session.advertiserId`, never `userId`) and a separate
   `requireAdvertiserAuth` middleware. An advertiser session grants zero access
   to `/api/me/*`, and vice versa.
2. **Mirror, don't fork.** Reuse the existing password hashing, rate-limit, and
   session helpers; do not copy the student `users` table semantics onto
   advertisers.
3. **Ads are content, not chrome.** Served ads render as a first-class
   `sponsored` widget inside the existing #52 dashboard registry
   (`pages/Home.jsx`) — clearly labeled, never disguised as student data.
4. **Measured, not estimated.** Every impression and tap is logged so the portal's
   "transparent analytics" promise is real.

---

## 3. Data model (proposed — Supabase, new `.sql` migration)

`supabase-advertiser-portal.sql` (idempotent, run once):

```
advertisers
  id              uuid pk
  email           text unique not null
  password_hash   text not null
  company_name    text not null
  contact_name    text
  status          text default 'active'   -- active | suspended
  created_at      timestamptz
  updated_at      timestamptz

advertiser_leads            -- from "Request access" before an account exists
  id            uuid pk
  email         text not null
  company_name  text
  message       text
  created_at    timestamptz

campaigns
  id            uuid pk
  advertiser_id uuid fk -> advertisers.id
  name          text not null
  placement     text not null    -- 'home-widget' | 'dining' | 'transit' | 'events'
  status        text default 'draft'   -- draft | pending_review | active | paused | ended
  starts_on     date
  ends_on       date
  creative      jsonb            -- { headline, body, imageUrl, ctaLabel, ctaUrl }
  created_at    timestamptz
  updated_at    timestamptz

ad_events                   -- impression / tap log
  id            uuid pk
  campaign_id   uuid fk -> campaigns.id
  kind          text not null    -- 'impression' | 'tap'
  occurred_at   timestamptz
  -- no student PII; aggregate only
```

Keep RLS off for these (server uses the service-role key and enforces ownership in
code, matching the existing `users`/`linked_sources` pattern).

---

## 4. API surface (Express, server.mjs)

Auth (separate from student auth):
- `POST /api/advertiser/sign-in` — verify against `advertisers`, regenerate session,
  set `req.session.advertiserId`. Reuse `signInRateLimit`.
- `POST /api/advertiser/sign-out`
- `POST /api/advertiser/request-access` — insert into `advertiser_leads`
  (rate-limited). This is what the `/advertise` "Request access" button should call.
- `GET  /api/advertiser/me` — current advertiser (gated by `requireAdvertiserAuth`).

Campaigns (all `requireAdvertiserAuth`, scoped to `req.session.advertiserId`):
- `GET    /api/advertiser/campaigns`
- `POST   /api/advertiser/campaigns`
- `PATCH  /api/advertiser/campaigns/:id`
- `GET    /api/advertiser/campaigns/:id/stats` — aggregated `ad_events`.

Ad serving + tracking (public / student-session, NOT advertiser-gated):
- `GET  /api/ads/active?placement=home-widget` — returns at most one active,
  in-window campaign's creative for a placement.
- `POST /api/ads/:campaignId/event` — body `{ kind: 'impression' | 'tap' }`,
  rate-limited, no PII.

`requireAdvertiserAuth` mirrors `requireAuth` but reads `req.session.advertiserId`
and looks up the `advertisers` row; returns 401 otherwise.

---

## 5. Frontend

- `AdvertiserLogin.jsx` — replace stubbed `handleSubmit` with a real call to
  `POST /api/advertiser/sign-in`; on success route to `/advertise/dashboard`.
  Wire "Request access" to `POST /api/advertiser/request-access`.
- New `pages/advertiser/Dashboard.jsx` (route `/advertise/dashboard`, guarded by a
  small `RequireAdvertiser` wrapper that checks `GET /api/advertiser/me`) —
  list campaigns, create/edit, view stats.
- New `lib/advertiserApi.js` — thin fetch wrapper (mirror `lib/authApi.js`,
  `credentials: 'include'`).
- Student side: a `sponsored` entry in the `widgetRegistry` in `pages/Home.jsx`
  that fetches `/api/ads/active?placement=home-widget`, renders a labeled
  "Sponsored" card, fires an impression on mount and a tap on click.

---

## 6. Milestones

- **M1 (next session): auth + data model.** `supabase-advertiser-portal.sql`,
  `advertisers` + `advertiser_leads`, sign-in/out + request-access endpoints,
  `requireAdvertiserAuth`, un-stub `AdvertiserLogin.jsx`. Tests for the auth path.
- **M2: campaigns dashboard.** Campaign CRUD endpoints + `/advertise/dashboard`
  with `RequireAdvertiser`.
- **M3: ad serving + analytics.** `/api/ads/*`, the `sponsored` home widget,
  `ad_events` logging, and a stats view in the dashboard.

---

## 7. Security checklist (per repo rules)

- [ ] Advertiser session key is distinct from `userId`; cross-access returns 401.
- [ ] Passwords hashed with the existing helper; never stored plaintext.
- [ ] Rate-limit sign-in, request-access, and `/api/ads/:id/event`.
- [ ] Ownership enforced server-side on every `campaigns` query (`advertiser_id =
      session advertiser`).
- [ ] `ad_events` stores **no** student PII — aggregate counts only.
- [ ] Creative `ctaUrl` validated (http/https only) before render to avoid
      `javascript:` injection in the served ad.
- [ ] "Sponsored" label always visible on served ads.

## 8. Open questions

- Self-serve signup vs. invite-only (currently invite-only via leads)?
- Does an ad need a `pending_review` approval step before going `active`?
- Billing — out of scope for now, or stub a "plan" field on `advertisers`?
