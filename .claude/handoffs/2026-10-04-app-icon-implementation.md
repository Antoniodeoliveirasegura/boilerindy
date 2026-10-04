# App icon: Monument Circle, adaptive light and dark

Decision taken by the owner on 2026-10-04 after a friends' vote and six rounds of review.
This brief is self-contained; the chat that produced it is not needed.

## Paste this into the new session

> Implement the BoilerIndy app icon described in `.claude/handoffs/2026-10-04-app-icon-implementation.md`
> (on branch `design/logo-candidates`, also copied into the shared checkout). Work in a fresh worktree off
> `origin/develop`, one PR into `develop`, no Co-Authored-By trailers, no em-dashes anywhere. Do not redesign
> the mark; the SVGs are final. Verify with the render script and the light/dark proof before opening the PR.

## What was chosen

- App icon: Monument Circle, monument only, thin ring. Gallery #35 in light mode (ink monument on the gold
  gradient), #36 in dark mode (gold monument on the ink gradient). One SVG carries both; the dark colourway
  sits behind `@media (prefers-color-scheme: dark)`.
- Favicon: the relief B, ink on gold in light, gold on ink in dark, same mechanism.
- Not chosen: the train on the circle (F1), the boilermaker figure (F4), the road band, the redrawn monument,
  the 3D renders. They exist in the generators; leave them alone.

## Where the files are (all pushed)

Branch `design/logo-candidates` (worktree `~/code/boilerindy-logos`, HEAD 3f4cda0 or later):

- `design/logo-marks/adaptive/app-icon.svg`: the app icon, final.
- `design/logo-marks/adaptive/favicon.svg`: the favicon, final.
- `design/logo-marks/adaptive.js`, `marks.js`, `circle.js`, `finalists.mjs`, `README.md`: generators, only
  needed if a colour or size must change. Regenerate with `adaptive(circleA, LIGHT, DARK)` where
  `LIGHT = {ground:'gold', subj:'ink', accent:'white', noTrain:true, band:3.4, lift:0}` and
  `DARK = {ground:'ink', subj:'gold', ...same}`.
- `boilerindy-react/public/logos-finalists.html` and `logos.html`: the review pages. Review only, never merge
  that branch.

Fetch a file without checking the branch out:

    git show origin/design/logo-candidates:design/logo-marks/adaptive/app-icon.svg > boilerindy-react/public/app-icon.svg
    git show origin/design/logo-candidates:design/logo-marks/adaptive/favicon.svg  > boilerindy-react/public/favicon.svg

`design/logo-marks/render-icons.reference.mjs` on the same branch is the reworked render script from the
earlier (never pushed) wiring attempt: gold-gradient ground, 'gold' and 'ink' pixel checks, the subject point
`INK_AT`, full-bleed and bare variants derived from the source SVG. Start from it for the script changes below:

    git show origin/design/logo-candidates:design/logo-marks/render-icons.reference.mjs

## The PR (one, into develop)

1. New worktree from `origin/develop`. Never check out or stash in `~/code/boilerindy` (shared, other
   sessions use it; git stash is shared across worktrees).
2. `boilerindy-react/public/favicon.svg`: replace with the adaptive B.
   `boilerindy-react/public/app-icon.svg`: new, the adaptive monument.
3. `boilerindy-react/scripts/render-icons.mjs`: port the reference version, then:
   - the ground-rect regex must be global: the adaptive SVG has two ground rects
     (`fill="url(#L_g)"` and `fill="url(#D_g)"`), so derive the full-bleed and bare variants with
     `replaceAll` / a `g` regex, not a single replace;
   - render every asset in a Playwright context created with `colorScheme: 'light'` so the SVG picks its
     light group (the OS takes one PNG for the home-screen tile and the light set is canonical);
   - optionally also write a dark set under `public/icons/dark/` from a `colorScheme: 'dark'` context for
     in-app or marketing use; nothing consumes it yet, so it is fine to skip in this PR;
   - keep the pixel checks: corners `gold` (or `ink` for dark renders), the subject point `INK_AT=[32,30]`
     in tile units, which lands on the monument shaft; the maskable icon insets the bare subject 20% on
     the gradient; the OG card draws the bare subject on the gradient, no tile inside a tile;
   - update the header comment to name the two sources.
4. `boilerindy-react/public/manifest.webmanifest`: first icon `src` becomes `/app-icon.svg` (keep the PNG
   entries; the script regenerates them).
5. `boilerindy-react/index.html`: the comment that says what the PNGs are rendered from; the
   `<link rel="icon" href="/favicon.svg">` already exists and needs no `media` attribute, the SVG switches
   by itself.
6. Run `node scripts/render-icons.mjs` from `boilerindy-react/` (playwright resolves from the workspace root;
   in a worktree without `node_modules`, symlink both `~/code/boilerindy/node_modules` and
   `~/code/boilerindy/boilerindy-react/node_modules` in, run, then remove the root symlink before
   committing: it shows as untracked). All five assets must print `ok`.
7. Prove the switch: load `public/favicon.svg` and `public/app-icon.svg` as `<img>` in a Playwright page
   with `colorScheme:'light'` and again with `'dark'`, and `goto` the SVG directly in each; gold in light,
   ink in dark. `design/logo-marks/README.md` describes the expected result.
8. Commit without trailers; the committed pre-commit hook rejects em and en dashes. Open an issue first if
   none exists ("App icon: Monument Circle, adaptive light and dark") and reference it; PR title
   `feat(icons): Monument Circle app icon with light and dark colourways`. Required checks on develop:
   test, e2e, conventions, db.

## Design facts, in case something must be touched

- Gold gradient `#FFC94A` to `#E08A12` at 135 degrees; ink gradient `#2A1E0C` to `#0D0803`.
- Ink subject material: radial `#4E3A1C`, `#2A1B0A`, `#120B04` lit from the upper left; gold subject
  `#FFE38A`, `#F2B02A`, `#C9780F`; cream accent `#FBF3E3`.
- Ring: ellipse centre (32,46), rx 24, ry 8.5, stroke 3.4; plaza disc the subject colour at 14% opacity.
- Monument: the v1 drawing (`monumentV1` in `circle.js`), base line y=47, h 42.
- Relief B extrusion: `#B8720E` on gold, `#6E4108` on ink.
- Platform truth: a PWA home-screen tile cannot switch with appearance; the browser tab, in-app logo and
  iOS startup images can. Do not promise otherwise in the PR body.

## Follow-ups, not this PR

- iOS startup images (`apple-touch-startup-image` with `media` attributes per device and scheme).
- Android themed icon (`purpose: "monochrome"` entry in the manifest).
- In-app header logo: `src/components/CampusAssistant.tsx` renders the name as text; the adaptive SVG can
  go beside it.
- The OG card wordmark still uses the system sans; Plus Jakarta Sans would need the font file in the repo.
