# Logo mark generators

Source for the marks on `/logos.html` and `/logos-finalists.html` (review branch only).

- `marks.js`: material system (gold and ink gradients, soft-plastic radial light, contact shadow) and the relief B, steam pin, locomotive and flat locomotive builders. Every builder is `fn(options, idPrefix)` and returns SVG markup for a 64-unit tile.
- `circle.js`: the Soldiers' and Sailors' Monument, the keyline helper, the boilermaker figure, Monument Circle (`circleA`) and the standalone mascot.
- `finalists.mjs`: the five finalists with their options, the page, and the lockup and social-card sources rendered to PNG with Playwright (the site CSP blocks web fonts, so the pages embed PNGs).

Render with Playwright from `boilerindy-react/` so the import resolves, for example:

    node --input-type=module -e "import { chromium } from 'playwright'; const F = await import('../design/logo-marks/finalists.mjs'); ..."

## Adaptive colourways

`adaptive.js` wraps a builder twice, light and dark, in one SVG with a `prefers-color-scheme` media query. `adaptive/app-icon.svg` (monument only, thin ring: gallery #35 in light, #36 in dark) and `adaptive/favicon.svg` (relief B, ink on gold in light, gold on ink in dark) are the outputs. The switch holds wherever the SVG is evaluated as a document: browser-tab favicons in Chromium and Firefox, inline SVG, and `<img>`. Home-screen icons are PNGs picked once by the OS, so they stay the light version.
