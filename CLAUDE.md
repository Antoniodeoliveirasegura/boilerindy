# Working in this repository

Guidance for coding agents (Claude Code, Codex and the like) and for people
who use one. The README is the human setup guide and holds the conventions in
full; this file is the map an agent needs before its first edit, kept short so
it stays true. When the two disagree, the README and CI win.

## What this is

BoilerIndy is a campus services app for Purdue University Indianapolis: an
Express backend (`server.mjs` plus `src/`) on Render, a React 19 + Vite +
TypeScript frontend (`boilerindy-react/`) on Vercel, Supabase for the database
and auth, and a Groq-backed campus assistant. `www.boilerindy.app` is the
production frontend; Vercel rewrites `/api/*` to the Render backend.

## Layout

- `server.mjs`: the Express app. It starts listening on import, so it is never
  imported by a test. Routes are registered as `app.<verb>('/api/...')`; the
  feature routers under `src/routes/` (issue #191, in progress; `layouts.mjs`
  is the first and the shape to copy) export `createXRouter(deps)` and are
  mounted where their routes used to be, with absolute paths inside.
  `docs/api-routes.md` is the generated inventory of every route and the file
  it lives in (`pnpm run docs:routes`; `test/apiRoutesDoc.test.mjs` fails when
  it is stale). The seven session-free public reads (transit, parking, clubs,
  push config, dining) are registered ahead of `app.use(session(...))` with a
  `Cache-Control` header so Vercel's edge can cache them; `test/publicReadKey.test.mjs`
  pins that block.
- `src/*.mjs`: backend modules, camelCase, named exports. Anything that needs a
  test lives here with a matching `test/<name>.test.mjs` (node:test, run with
  `pnpm test:backend`), and the route handler in `server.mjs` stays thin. The
  shared modules the frontend also imports (`dashboardLayout.mjs`,
  `servicesLayout.mjs`, `boardLimits.mjs`, `marketplace.mjs`,
  `degreePrograms.mjs`, `purdueMajors.mjs`, `gradeTracker.mjs`) keep the browser
  and the API on one set of values.
- `src/dbErrors.mjs` and `docs/api-error-codes.md`: the error envelope
  `{ error: { message, status, code? } }` every new route answers with; a
  missing table answers 503 with `<feature>_schema_missing`.
- `src/rateLimiter.mjs` and `docs/RATE_LIMITS.md`: every limiter is a
  `createRateLimiter` bucket, and `test/rateLimitDocs.test.mjs` fails when a
  limiter or one of its routes is missing from the doc.
- `db/*.sql`: Supabase migrations, applied in the README "Database setup"
  order. `test/dbApplyOrder.test.mjs` pins the list; CI replays every file on
  an empty Postgres.
- `scripts/`: admin and maintenance scripts run by hand; CI syntax-checks
  them. `scripts/check-conventions.mjs` is the conventions scanner.
- `docs/`: feature and ops notes, indexed one line per file in
  `docs/README.md`. A new feature with any operator surface gets a page and an
  index line.
- `boilerindy-react/src/`: `pages/` (PascalCase, default exports, one per
  route), `components/`, `context/` (auth, theme), `hooks/`, `lib/` (camelCase,
  named exports: API clients and per-user browser stores). Imports are
  relative. `lib/queries/` is the TanStack Query layer (issues #251 and
  #327): public reads persisted to localStorage, per-user reads keyed by the
  user and never persisted; `docs/client-cache.md` has the map.
- `e2e/`: Playwright specs against the built frontend with the backend mocked
  at the network layer by `e2e/fixtures/mock-backend.js` (`mockApi.login()`,
  `mockApi.logout()`, the `seed*` helpers; an unmapped `/api/**` path answers
  `200 { items: [], ok: true }`). No Supabase credentials are needed.

## Where a change goes

- Backend logic: a function in `src/*.mjs` with its test, then the thin route.
- A new route: register it (a session-free public read goes in the block
  ahead of the session middleware, with the `publicReadIpRateLimit` and
  `publicReadRateLimit` pair and a `Cache-Control` header), list it in
  `docs/RATE_LIMITS.md` if it carries a limiter (a limiter that meters only
  some requests takes a `skip` predicate rather than a wrapper, so the doc
  guard still sees it on the route line), regenerate `docs/api-routes.md` with
  `pnpm run docs:routes`, and use the error envelope.
- A migration: a new `db/*.sql` file added to the README order; never edit an
  applied file in place.
- Frontend logic: `lib/` with a colocated `*.test.ts`; components and pages get
  `*.test.tsx` next to them (Vitest and Testing Library, `pnpm -C
  boilerindy-react test`).
- Per-user browser state: keys carry the user id, saving refuses without one,
  and sign-out clears it (see `createLocalLayoutStore.ts` and
  `queries/userData.ts`).
- Anything the operator has to know (an env variable, a console setting, a
  cron): `.env.example` (pinned by `test/envExample.test.mjs`), the README
  table, or a `docs/` page.

## Conventions CI enforces

- No em dash (U+2014) or en dash (U+2013) anywhere in a tracked file, a commit
  message or a PR description. Use a hyphen, a comma or a colon. The committed
  git hooks (`.githooks/`, activated by `pnpm install`) and the `conventions`
  CI job both scan.
- No `Co-Authored-By` trailer or "Generated with" footer that credits an AI
  assistant, in commits or PR descriptions. Crediting a person is fine.
- pnpm only, with `--frozen-lockfile`, at the root and again inside
  `boilerindy-react/` (separate lockfile). Never `npm install`.
- LF line endings everywhere.
- Lint must be error-clean; the React Compiler advisory rules stay warnings.

## Workflow

- Branch from `develop` (`git checkout develop && git pull --ff-only`). One
  branch and one PR per issue, base `develop`. `main` is production and only
  receives release PRs from `develop`.
- PR title in conventional-commit style with the issue number, for example
  `fix(board): cap body length (#200)`. Commits the same way.
- Before opening the PR, run the CI mirror and have every step green:
  `pnpm test:backend`; `pnpm -C boilerindy-react run lint`, `run typecheck`,
  `test`, `run build`; `pnpm exec playwright test` (Chromium once via
  `pnpm exec playwright install chromium`); `pnpm run check:conventions`.
- Then post a status comment on the issue in the existing voice: a heading
  `### <what> landed in #<PR> (<date>)`, bullets of what changed and what was
  verified, and `Still open, owner only:` when something remains. Do not
  merge; the owner merges. Do not edit `boilerindy-app` (a separate repo)
  unless the issue says so.
- Issue briefs carry line numbers verified on a given `develop` commit.
  Re-grep before editing; `server.mjs` moves by hundreds of lines a week.
- Labels: `ready-for-agent` issues carry a brief an agent can execute;
  `ready-for-human` and `blocked` ones need a decision or a console setting
  from the owner.

## In flight

- Issue #191: `server.mjs` is being split into feature routers under
  `src/routes/`, one router per PR, in the order the issue brief gives. The
  prerequisites (#349) and the `layouts` router (#350) landed on 2026-09-25;
  `lostFound`, `deals`, `guide`, `studyGroups`, `marketplace` and `friends`
  remain, each following `createLayoutsRouter`. A router's limiter is only
  seen by the doc guard when it destructures the limiter under the name
  `server.mjs` uses.

## Landed recently

- The client data cache (issues #251 and #327, 2026-09-25). Public reads
  (`lib/queries/publicData.ts`, persisted to localStorage) and per-user reads
  (`lib/queries/userData.ts`, keyed by the user id, never persisted, dropped
  on sign-out) go through the query hooks in `boilerindy-react/src/lib/queries/`;
  new pages read through them rather than a `useEffect` with `fetch`.
  `docs/client-cache.md` has the keys, stale times, polling and retry rules
  and the three client settings that matter: `networkMode: 'always'`, the
  24 h `gcTime` for restored rows, and no mutation persistence. Phase 3, a
  service worker cache, is #328 and an owner decision.
- The edge cache for the public reads (#250, 2026-09-25): the block described
  under Layout. A user-specific response must never carry a `public`
  `Cache-Control`.
