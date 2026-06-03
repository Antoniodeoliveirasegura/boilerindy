# BoilerIndy

BoilerIndy is a campus services web application for Purdue University Indianapolis. It combines a Node.js/Express backend with a React + Vite frontend, integrating Supabase, Purdue authentication, campus schedules, dining, transit, board, and an AI campus assistant.

---

## Repository structure

```
boilerindy/
├── server.mjs                     # Express backend entry point
├── auth.mjs                       # Auth helpers
├── boardProfanity.mjs             # Board content moderation
├── nutrisliceDining.mjs           # Dining data (Nutrislice API)
├── purdueCalendarAutomation.mjs   # Purdue calendar capture
├── scripts/
│   └── seed-test-user.mjs         # Seed a test user
├── supabase-schema.sql            # Core DB schema (run once in Supabase)
├── supabase-board-only.sql        # Board tables schema
├── supabase-user-tasks.sql        # User tasks schema
├── .env.example                   # Backend env template — copy to .env
├── boilerindy-react/                # React + Vite frontend
│   ├── src/
│   │   ├── pages/                 # Route-level page components
│   │   ├── components/            # Layout, navbar, auth guards
│   │   ├── context/               # Auth and theme context
│   │   └── lib/                   # API helpers, Supabase client, utilities
│   ├── vite.config.js             # Vite config with dev proxy
│   └── .env.example               # Frontend env template — copy to .env
```

**Branches:**
- `main` — production (deployed to Vercel + Render)
- `develop` — local development and testing

---

## Local Development Setup

This section explains how to run the full stack (frontend + backend) on your own machine. No hosted dev backend is needed — the backend runs locally and Vite proxies all API calls to it automatically.

### Prerequisites

- **Node.js 20+** — check with `node -v`. Install from [nodejs.org](https://nodejs.org) or use `nvm`.
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

This is configured in `boilerindy-react/vite.config.js`. In production, Vercel rewrites handle the same routing to the Railway backend — the frontend code never changes between environments.

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
3. That's it — no Railway account, no Vercel account, no separate backend hosting required.

---

## Database setup

Run these SQL files **once** in your Supabase project's SQL Editor (Supabase dashboard → SQL Editor):

1. `supabase-schema.sql` — core tables: `users`, `linked_sources`, `calendar_items`, `board_posts`, `board_replies`, `board_upvotes`
2. `supabase-user-tasks.sql` — tasks tables: `user_task_completions`, `user_manual_tasks`
3. `supabase-board-only.sql` — only needed if board tables are missing separately

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

# From boilerindy-react/
npm install          # Install frontend dependencies
npm run dev          # Start frontend on :5173
npm run build        # Production build
npm run preview      # Preview production build locally
npm run lint         # Run ESLint

# Utilities (from repo root, backend must be running)
node scripts/seed-test-user.mjs
```

## License

This repository does not include a license file. Add one if you intend to share or publish the project.
