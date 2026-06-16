# TypeScript Migration (issue #20)

The frontend is migrating from JavaScript to TypeScript **incrementally**, so the
app keeps building and shipping the whole time.

## Setup (done in this PR)

- `typescript` added as a dev dependency.
- `tsconfig.json` with `strict: true`, **`allowJs: true`, `checkJs: false`** — existing
  `.js`/`.jsx` keep building untyped while new/converted `.ts`/`.tsx` are strictly checked.
- `pnpm typecheck` (`tsc --noEmit`) — run it in CI alongside `lint`, `test`, `build`.
- Vite and Vitest already understand `.ts`/`.tsx` (esbuild), so no bundler changes are needed.

## How to convert a file

1. Rename `foo.js` → `foo.ts` (or `foo.jsx` → `foo.tsx`).
2. Add types to exported functions/props; let TS infer locals.
3. `pnpm typecheck` must pass; `pnpm build` and `pnpm test` must stay green.
4. Imports use no extension, so callers/tests don't change.

Suggested order: pure `lib/` utilities → custom hooks → presentational components →
container components/pages → `App.tsx`/`main.tsx`.

## Status

- ✅ Foundation: `tsconfig.json`, `typescript` dep, `typecheck` script, CI `typecheck` step.
- ✅ Converted (`src/lib`): `privacyNav.ts`, `diningFavorites.ts`, `scheduleFilters.ts`,
  `taskPriorityStore.ts`, `buildingCode.ts`, `taskLocalStore.ts`.
- ✅ Converted (`src/hooks`): `usePrefersReducedMotion.ts`.
- ⬜ Remaining: the API helpers in `src/lib` (`authApi`, `adminApi`, `advertiserApi`,
  `spotlightApi`, `supabase`), `transitShared`, `gradeTrackerStore`, `dashboardLayoutStore`,
  `usageStats`; the rest of `src/hooks`; then `src/components`, `src/pages`, `src/context`.

## Follow-ups

- Add **typescript-eslint** so `.ts`/`.tsx` are linted (the current ESLint flat config
  only matches `**/*.{js,jsx}`, so `.ts` files are type-checked by `tsc` but not yet linted).
- Once coverage is high, flip `checkJs: true` (then remove `allowJs`) to type-check the
  remaining `.js` and finish the migration.
