---
name: boilerindy
description: Repo-specific patterns for boilerindy: where backend and frontend code goes, naming and export conventions, the test layers, the develop-based one-PR-per-issue workflow and the conventions CI enforces. Use when changing anything in this repository.
---

# boilerindy development patterns

The full map and the workflow live in `CLAUDE.md` at the repository root and
in the README's "Conventions" section; read those first. This skill keeps the
patterns an agent applies most, so it can be loaded on its own.

## Architecture in one paragraph

An Express backend (`server.mjs`, with feature routers moving to
`src/routes/` under issue #191; `layouts.mjs` is the first) whose logic lives
in `src/*.mjs` modules, each with a `test/<name>.test.mjs`, and whose seven
session-free public reads sit ahead of the session middleware so the edge can
cache them; a React 19 + Vite + TypeScript frontend in
`boilerindy-react/` (`pages/`, `components/`, `context/`, `hooks/`, `lib/`,
with the TanStack Query layer in `lib/queries/`); Supabase migrations in
`db/*.sql` applied in README order; Playwright specs in `e2e/` against a mocked
backend. Some `src/*.mjs` modules are imported by both sides so the browser and
the API share one set of limits, layouts and programs.

## Naming and exports

- Backend modules: camelCase `.mjs`, named exports, one concern per file.
- Frontend pages and components: PascalCase `.tsx`, default exports.
- Frontend `lib/` and `hooks/`: camelCase `.ts`/`.tsx`, named exports.
- Imports are relative (`../lib/authApi`); the shared root modules are reached
  as `../../../src/<name>.mjs`.
- Every file under `boilerindy-react/src/` is TypeScript; `allowJs` stays on
  only for those shared `.mjs` imports.

## Tests, by layer

| Layer | Tool | Where | Run |
|---|---|---|---|
| Backend module | node:test | `test/<name>.test.mjs` | `pnpm test:backend` |
| Frontend unit | Vitest + Testing Library | colocated `*.test.ts(x)` | `pnpm -C boilerindy-react test` |
| End to end | Playwright | `e2e/*.spec.js` with `e2e/fixtures/mock-backend.js` | `pnpm exec playwright test` |
| Docs guards | node:test | `test/rateLimitDocs.test.mjs`, `test/apiRoutesDoc.test.mjs`, `test/envExample.test.mjs`, `test/dbApplyOrder.test.mjs` | in `pnpm test:backend` |

`server.mjs` starts listening on import, so route handlers are not unit
tested: put the logic in a module and keep the handler thin. Frontend tests
mock `../lib/authApi` and `../context/AuthContext` with `vi.mock`; pages that
read through the query layer render under a `QueryClientProvider` (see
`src/pages/Dining.test.tsx`).

## Commits and pull requests

Conventional-commit style with the issue number: `feat(scope): what changed
(#123)`. Branch from `develop`, one branch and one PR per issue, base
`develop`. No em or en dashes anywhere, no AI co-author trailers or "Generated
with" footers: the committed hooks and CI reject both. pnpm only. Finish with
the CI mirror green and a status comment on the issue.

## Workflow commands

The scaffolds in `.claude/commands/` are starting points, not scripts:

| Command | Use |
|---|---|
| `/feature-development` | a change that spans a `src/*.mjs` module, its test, a route and a page |
| `/database-migration` | a new `db/*.sql` file, its README order entry and the code that depends on it |
| `/rebranding-across-codebase` | renaming a product or brand across code, assets and docs |
