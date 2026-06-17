# BoilerIndy

BoilerIndy is a campus services web application for Purdue University Indianapolis. It combines a Node.js/Express backend with a React + Vite frontend, integrating Supabase, Purdue authentication, campus schedules, dining, transit, board, and an AI campus assistant.

---

## Repository structure

```
boilerindy/
├── server.mjs                  # Express backend entry point
├── src/                        # Backend modules imported by server.mjs
│   ├── scheduleSync.mjs            # Purdue schedule import + recurrence expansion
│   ├── icsFeed.mjs                 # Subscribable .ics calendar feed builder
│   ├── nutrisliceDining.mjs        # Dining data (Nutrislice API)
│   ├── boardProfanity.mjs          # Board content moderation
│   ├── gradeTracker.mjs            # Grade tracker + degree planner logic
│   ├── advertiser*.mjs             # Advertiser portal (auth, campaigns, ad serving, admin)
│   └── …                           # analytics, rate limiting, email, password hashing, etc.
├── test/                       # Backend unit tests (node:test) — one *.test.mjs per module
├── e2e/                        # Playwright end-to-end tests
├── db/                         # Supabase SQL schema/migrations (run in the SQL Editor)
│   ├── supabase-schema.sql         # Core DB schema (run once)
│   ├── supabase-board-only.sql     # Board tables
│   ├── supabase-user-tasks.sql     # User tasks
│   └── …                           # calendar feed, lost & found, dashboard, advertiser, analytics
├── scripts/                    # Admin / maintenance CLI scripts
├── docs/                       # Feature & ops documentation
├── .env.example                # Backend env template — copy to .env
└── boilerindy-react/           # React + Vite frontend
    ├── src/
    │   ├── pages/                  # Route-level page components
    │   ├── components/             # Layout, navbar, auth guards
    │   ├── context/                # Auth and theme context
    │   └── lib/                    # API helpers, Supabase client, utilities
    ├── vite.config.js              # Vite config with dev proxy
    └── .env.example                # Frontend env template — copy to .env
```

**Branches:**
- `main` — production (deployed to Vercel + Render)
- `develop` — local development and testing

---

## Local Development Setup

This section explains how to run the full stack (frontend + backend) on your own machine. No hosted dev backend is needed — the backend runs locally and Vite proxies all API calls to it automatically.

### Prerequisites

- **Node.js 22+** — check with `node -v`. Install from [nodejs.org](https://nodejs.org) or use `nvm`. (CI runs on Node 22.)
- **npm** — comes with Node.js.
- **Supabase project** — you and your teammate share the same Supabase project. Get the credentials from the project owner or the Supabase dashboard.

---

### 1. Clone the repo and switch to develop

```bash
git clone https://github.com/Antoniodeoliveirasegura/boilerindy.git
cd boilerindy
git checkout develop
```

---

### 2. Install backend dependencies

From the **repo root**:

```bash
npm install
```

---

### 3. Set up the backend `.env`

```bash
# macOS / Linux
cp .env.example .env

# Windows
copy .env.example .env
```

Open `.env` and fill in the values:

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → service_role key |
| `SUPABASE_ANON_KEY` | Supabase dashboard → Settings → API → anon (public) key |
| `SESSION_SECRET` | Any long random string (e.g. `openssl rand -hex 32`) |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com/app/apikey) — free tier works |
| `PORT` | Leave as `3000` |
| `HOST` | Leave as `127.0.0.1` |
| `CLIENT_APP_URL` | Leave as `http://localhost:5173` |
| `PURDUE_AUTH_MODE` | Leave as `mock` for local dev |
| `DEV_PURDUE_EMAIL` | Any `@purdue.edu` address, used on the mock link screen |

> **Note:** `GEMINI_API_KEY` is optional. If omitted, the campus assistant and board AI features return a 503 but everything else works.

---

### 4. Install frontend dependencies

```bash
cd boilerindy-react
npm install
cd ..
```

---

### 5. Set up the frontend `.env`

```bash
# macOS / Linux
cd boilerindy-react && cp .env.example .env && cd ..

# Windows
cd boilerindy-react
copy .env.example .env
cd ..
```

Open `boilerindy-react/.env` and fill in:

| Variable | Where to get it |
|---|---|
| `VITE_SUPABASE_URL` | Same Supabase URL as the backend |
| `VITE_SUPABASE_ANON_KEY` | Supabase dashboard → Settings → API → anon (public) key |

Leave `VITE_API_PROXY` commented out — it defaults to `http://127.0.0.1:3000` which is where the local backend runs.

---

### 6. Run the backend

From the **repo root**:

```bash
npm run dev
```

You should see:

```
BoilerIndy backend listening on http://127.0.0.1:3000
Purdue link mode: mock
Database: Supabase
```

---

### 7. Run the frontend

In a **separate terminal**, from `boilerindy-react/`:

```bash
cd boilerindy-react
npm run dev
```

Vite starts at **http://localhost:5173**.

---

### 8. Verify the connection

Open http://localhost:5173. The login page should load. To confirm the frontend is talking to the backend, run:

```bash
curl http://localhost:5173/api/session
# Expected: {"authenticated":false,"session":null}
```

If you get a valid JSON response, the full stack is working.

---

### How the dev proxy works

In development, **you never need to set a backend URL in the frontend**. Vite automatically proxies:

- `/api/*` → `http://127.0.0.1:3000/api/*`
- `/auth/purdue/*` → `http://127.0.0.1:3000/auth/purdue/*`

This is configured in `boilerindy-react/vite.config.js`. In production, Vercel rewrites handle the same routing to the Render backend — the frontend code never changes between environments.

---

### Troubleshooting

**`Cannot find package 'dotenv'` or module not found on backend start**
Run `npm install` from the repo root. Dependencies aren't installed.

**`'vite' is not recognized` on frontend start**
Run `npm install` from inside `boilerindy-react/`. Frontend dependencies aren't installed.

**Backend exits immediately with `Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`**
Your `.env` is missing or empty. Make sure `.env` exists in the **repo root** (not inside `boilerindy-react/`) and contains valid Supabase credentials.

**Frontend loads but all API calls fail**
The backend isn't running. Start it first (`npm run dev` from repo root), then start the frontend in a second terminal.

**Port 3000 already in use**
Another process holds port 3000. Kill it, or change `PORT` in the root `.env` and set `VITE_API_PROXY=http://127.0.0.1:<new-port>` in `boilerindy-react/.env`.

**Port 5173 already in use**
Vite automatically tries 5174, 5175, etc. Check which port Vite actually started on in the terminal output, then update `CLIENT_APP_URL` in the root `.env` to match (e.g. `http://localhost:5174`).

**CORS errors in the browser console**
This should not happen with the Vite proxy active. If you see CORS errors, make sure you're accessing the app through Vite (`http://localhost:5173`) and not directly from `http://localhost:3000`.

**`fetch failed` errors in the backend console**
The backend makes outbound requests to Nutrislice (dining), TransLoc (transit), and Gemini (AI). These can fail when external services are down — it does not affect auth, calendar, or board features.

**Supabase errors — `table does not exist` or `schema cache`**
The database schema hasn't been applied. See the [Database setup](#database-setup) section below.

---

## What a teammate needs to do

1. Get the Supabase credentials (URL, service role key, anon key) from the project owner.
2. Follow steps 1–8 above.
3. That's it — no Render account, no Vercel account, no separate backend hosting required.

---

## Database setup

Run these SQL files (in `db/`) **once** in your Supabase project's SQL Editor (Supabase dashboard → SQL Editor):

1. `db/supabase-schema.sql` — core tables: `users`, `linked_sources`, `calendar_items`, `board_posts`, `board_replies`, `board_upvotes`
2. `db/supabase-user-tasks.sql` — tasks tables: `user_task_completions`, `user_manual_tasks`
3. `db/supabase-calendar-feed.sql` — adds `users.calendar_feed_token` for the subscribable calendar feed
4. `db/supabase-lost-found.sql` — adds the `lost_found_items` table for the Lost & Found feature
5. `db/supabase-dashboard-layout.sql` — adds `users.dashboard_layout` for the customizable home dashboard
6. `db/supabase-services-layout.sql` — adds `users.services_layout` for the customizable Student Services board
7. `db/supabase-board-only.sql` — only needed if board tables are missing separately

All files are safe to re-run (`CREATE TABLE IF NOT EXISTS`, `DROP TRIGGER IF EXISTS`).

---

## Production deployment

- **Frontend** — Vercel, auto-deploys from `main`
- **Backend** — Render, running `node server.mjs`
- **Routing** — `boilerindy-react/vercel.json` rewrites `/api/*` and `/auth/purdue/*` to the Render backend URL

Do not merge dev-only env variables into `main`. Production secrets are configured in the Vercel and Render dashboards, not in this repo.

---

## Backend details

- Framework: Express
- Session: `express-session` (cookie-based, `httpOnly`, `sameSite: lax`)
- Database: Supabase (Postgres via `@supabase/supabase-js`)
- Auth: local email/password + optional Purdue CAS
- External integrations: Nutrislice dining API, TransLoc transit API, Google Gemini

### Calendar feed (subscribable .ics)

Each user can mint a private, subscribable calendar feed of their classes
(`calendar_items`, next 6 months) and incomplete tasks (`user_manual_tasks`):

- `POST /api/me/calendar-feed/token` (auth required) creates or regenerates the
  feed token and returns the full URL. Regenerating **immediately invalidates**
  the previous URL.
- `GET /feeds/calendar/<token>.ics` is **unauthenticated** — calendar apps
  cannot log in, so the UUID v4 token is the only credential. It resolves to a
  single user, is rate-limited per IP, is never logged, and returns `404` for an
  unknown or malformed token. Treat the URL like a password.

The token lives in `users.calendar_feed_token` (see `db/supabase-calendar-feed.sql`)
and is minted lazily on first request. ICS is generated by hand in `src/icsFeed.mjs`
(RFC 5545: CRLF endings, comma/semicolon/newline escaping, 75-octet line folding)
because `node-ical` is parse-only.

### Free Food (issue #46)

`src/freeFood.mjs` is a pure keyword matcher (`hasFreeFood(title, description)`).
`listCalendarItems` tags every calendar item with `freeFood: boolean`, which
powers a 🍕 badge + filter on the Events page and a dedicated `/free-food`
page. No schema change.

### Lost & Found (issue #47)

A standalone feature (not a board category): the `/lost-found` page lets students
post lost/found items, search them, and mark their own posts resolved. Backed by
the `lost_found_items` table (`db/supabase-lost-found.sql`) and CRUD endpoints under
`/api/lost-found`, with author-only edit/delete and the shared board profanity
filter applied to all text.

## Frontend details

- Framework: React 19 + Vite
- Styling: Tailwind CSS v4
- Auth: Supabase Auth + session sync with backend
- Maps: Leaflet + React Leaflet
- All API calls use relative paths, proxied to the backend by Vite in dev and by Vercel rewrites in production

## Useful commands

```bash
# From repo root
npm install          # Install backend dependencies
npm run dev          # Start backend on :3000
npm run test:backend # Run backend unit tests (node:test)
npm run test:e2e     # Run Playwright E2E suite (builds + previews the frontend,
                     # mocks the backend — no Supabase creds needed)

# From boilerindy-react/
npm install          # Install frontend dependencies
npm run dev          # Start frontend on :5173
npm run build        # Production build
npm run preview      # Preview production build locally
npm run lint         # Run ESLint

# Admin / maintenance scripts (from repo root, needs backend .env)
node scripts/grant-admin.mjs --email=you@gmail.com      # grant/revoke platform admin
node scripts/create-advertiser.mjs                       # mint an advertiser-portal account
node scripts/review-campaign.mjs                         # approve a pending ad campaign
node scripts/clear-purdue-link.mjs --email=you@gmail.com # clear a stale Purdue link
```

## License

This repository does not include a license file. Add one if you intend to share or publish the project.
