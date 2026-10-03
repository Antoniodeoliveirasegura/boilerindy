# Logo mark generators

Source for the marks on `/logos.html` and `/logos-finalists.html` (review branch only).

- `marks.js`: material system (gold and ink gradients, soft-plastic radial light, contact shadow) and the relief B, steam pin, locomotive and flat locomotive builders. Every builder is `fn(options, idPrefix)` and returns SVG markup for a 64-unit tile.
- `circle.js`: the Soldiers' and Sailors' Monument, the keyline helper, the boilermaker figure, Monument Circle (`circleA`) and the standalone mascot.
- `finalists.mjs`: the five finalists with their options, the page, and the lockup and social-card sources rendered to PNG with Playwright (the site CSP blocks web fonts, so the pages embed PNGs).

Render with Playwright from `boilerindy-react/` so the import resolves, for example:

    node --input-type=module -e "import { chromium } from 'playwright'; const F = await import('../design/logo-marks/finalists.mjs'); ..."
