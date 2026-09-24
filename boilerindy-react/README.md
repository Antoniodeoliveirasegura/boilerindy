# BoilerIndy frontend

The React app behind www.boilerindy.app: React 19, Vite, Tailwind CSS v4 and TypeScript, with Supabase Auth in the browser and a cookie session against the Express backend in the repository root. The root [README](../README.md) has the full local setup (backend `.env`, database, both servers) and the repo conventions. This file covers what is specific to this package.

## Setup

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

pnpm only: the `preinstall` script refuses `npm install` and `yarn`. `.env.example` documents every variable; two are required.

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | The same Supabase project URL the backend uses |
| `VITE_SUPABASE_ANON_KEY` | That project's anon (public) key |

`VITE_API_PROXY` is where the dev server sends `/api/*` and `/auth/purdue/*`. It defaults to `http://127.0.0.1:3000`, where the local backend listens, so leave it commented out unless the backend runs elsewhere. `VITE_SENTRY_DSN` and the `SENTRY_*` build variables are optional and explained in the template. Only `VITE_*` variables reach the browser bundle; backend secrets belong in the root `.env`, never here.

## Scripts

```bash
pnpm run dev          # Vite dev server on http://localhost:5173, proxying to the backend
pnpm run build        # Production build into dist/
pnpm run preview      # Serve the production build locally
pnpm run lint         # ESLint; must be error-clean, the React Compiler advisories stay warnings
pnpm run typecheck    # tsc --noEmit over src/
pnpm test             # Vitest + Testing Library, one run (pnpm run test:watch to keep it running)
pnpm run render-icons # Re-render the PNG launch assets under public/ from public/favicon.svg
```

CI runs lint, typecheck, test and build in that order, so run those four before opening a pull request. The Playwright suite lives in `../e2e` and runs from the repository root with `pnpm run test:e2e`: it builds this package, serves it with `vite preview` and mocks the backend at the network layer, so it needs no Supabase credentials.

## How the dev proxy works

In development the frontend never needs a backend URL. `vite.config.js` proxies `/api/*` and `/auth/purdue/*` to `VITE_API_PROXY` (and nothing else: `/auth/callback` belongs to the React app and Supabase). In production, Vercel rewrites route the same paths to the Render backend, so the application code is identical in both environments.

## Layout

- `src/pages/` holds the routed pages, `src/components/` the shared components, `src/context/` the auth and theme contexts, `src/hooks/` the custom hooks and `src/lib/` the API clients and browser-side stores.
- Tests sit next to the code as `*.test.ts` and `*.test.tsx`. The Vitest config is the `test` block of `vite.config.js`; `vitest.setup.js` loads jest-dom and stubs `matchMedia`.
- Some pages import the shared modules under the repository root `src/` (limits, layouts, degree programs) so the browser and the API agree on one set of values. Those modules are plain JavaScript, which is why `tsconfig.json` keeps `allowJs` on.
- Every file under `src/` is TypeScript. The incremental migration (issue #20) is finished, and lint covers `.ts` and `.tsx` through `typescript-eslint` (issue #183).
