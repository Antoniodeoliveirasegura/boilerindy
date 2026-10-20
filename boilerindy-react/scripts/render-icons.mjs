// Renders the PNG launch assets from public/app-icon.svg (issues #155, #408) and
// splits the in-app brand mark out of it (#433).
//
//   node scripts/render-icons.mjs        (run from boilerindy-react/)
//   pnpm run render-icons
//
// Sources, both under public/, both adaptive: one SVG holds a light and a dark
// colourway and shows the dark one under @media (prefers-color-scheme: dark).
//   app-icon.svg    Monument Circle: the monument on its thin ring, ink on a gold
//                   tile in light mode and gold on an ink tile in dark mode; the app
//                   icon at 60px and up, and the in-app brand mark (below)
//   favicon.svg     the monument alone, no tile and no ring, scaled to the full
//                   height so it reads at 16px: ink in light mode, gold in dark;
//                   browser tabs and 16 to 32px contexts (served directly by
//                   index.html, nothing is rendered from it)
//
// The brand mark is split, not rendered: each colourway group of app-icon.svg is
// copied out without the tile, the shadow the tile casts and the <style> that
// switches them, so the monument on its ring sits straight on the page and
// components/BrandMark.tsx can follow the app's own theme class instead of the
// device setting. Both copies are drawn and pixel-checked like the PNGs.
//   brand/mark-light.svg          the light group: the ink monument on its ring, for light pages
//   brand/mark-dark.svg           the dark group: the gold monument on its ring, for dark pages
//
// Outputs, all under public/, rendered from the light colourway: a home-screen
// tile is one PNG that cannot follow the device's appearance, and gold is canonical.
//   apple-touch-icon.png          180x180, full-bleed gold ground (iOS masks the corners itself)
//   icons/icon-192.png            192x192, rounded tile on transparent, manifest purpose "any"
//   icons/icon-512.png            512x512, rounded tile on transparent, manifest purpose "any"
//   icons/icon-512-maskable.png   512x512, subject inset 20% on the full-bleed gold ground, purpose "maskable"
//   icons/icon-512-monochrome.png 512x512, the subject's silhouette in black, inset 20% on transparent, purpose "monochrome"
//   og-image.png                  1200x630 social preview card (Open Graph / Twitter)
//   og-transit.png                1200x630 card for a shared /transit link (docs/share-links.md)
//   og-dining.png                 1200x630 card for a shared /dining link
//
// Headless Chromium (Playwright, already a workspace dev dependency for e2e) is
// launched exactly once, in a light colour-scheme context; every asset is
// rendered, written and then read back and pixel-checked in that same session.
// The card is set in Plus Jakarta Sans, the wordmark's face (issue #434): its
// SemiBold, Bold and ExtraBold from scripts/fonts/ (SIL OFL 1.1, OFL.txt beside
// them), embedded as data URLs, so the glyph shapes no longer depend on the
// machine running this; anti-aliasing still can, slightly. The fonts are read
// here and never served. A face that does not load stops the run before the
// card's screenshot, so the card cannot fall back to a system font unnoticed.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url))

const GOLD_A = '#FFC94A' // gold ground gradient, top-left stop (matches the SVG sources)
const GOLD_B = '#E08A12' // gold ground gradient, bottom-right stop
const GOLD_GROUND = `linear-gradient(135deg, ${GOLD_A}, ${GOLD_B})`
const INK = '#1A1206' // wordmark on the card
const INK_SOFT = '#3A2810' // tagline on the card
const INK_DOMAIN = '#7A4A08' // domain line on the card
const TAGLINE = 'Your Purdue Indianapolis campus companion - schedule, dining, transit, board, and more.'
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const MASKABLE_SAFE_PADDING = 0.2 // fraction of each edge kept clear of the subject

// Plus Jakarta Sans 2.7.1, the release's static TTFs converted to WOFF2
// (scripts/fonts/README.md), one face per weight the card uses.
const FONT_DIR = fileURLToPath(new URL('./fonts/', import.meta.url))
const CARD_FAMILY = 'Plus Jakarta Sans'
const CARD_FACES = [
  { weight: 600, file: 'PlusJakartaSans-SemiBold.woff2' }, // tagline
  { weight: 700, file: 'PlusJakartaSans-Bold.woff2' }, // domain line
  { weight: 800, file: 'PlusJakartaSans-ExtraBold.woff2' }, // wordmark
]
const cardFontFaces = (
  await Promise.all(
    CARD_FACES.map(async ({ weight, file }) => {
      const data = (await readFile(path.join(FONT_DIR, file))).toString('base64')
      return `@font-face { font-family: '${CARD_FAMILY}'; font-style: normal; font-weight: ${weight};
      src: url(data:font/woff2;base64,${data}) format('woff2'); }`
    }),
  )
).join('\n')

// Each colourway draws its ground as one rounded rect first, so the source has
// two (fill url(#L_g) for light, url(#D_g) for dark). The full-bleed and bare
// variants are derived from it by changing or removing both, so all stay in sync.
const appIcon = await readFile(path.join(PUBLIC_DIR, 'app-icon.svg'), 'utf8')
const GROUND_RECT = /<rect width="64" height="64" rx="14" fill="url\(#[^"]+\)"\/>/g
const groundRects = appIcon.match(GROUND_RECT) ?? []
if (groundRects.length !== 2) {
  throw new Error(`app-icon.svg: expected 2 rounded ground rects (light and dark), found ${groundRects.length}`)
}
const appIconFullBleed = appIcon.replace(GROUND_RECT, (m) => m.replace('rx="14"', 'rx="0"'))
const appIconBare = appIcon.replace(GROUND_RECT, '')

// The in-app mark sits straight on the page (the header, the sign-in panel), so
// it also drops the soft shadow the tile casts at its foot, which on a light
// page would read as a smudge under the ring. The plaza disc and the shaft's
// highlight belong to the monument and stay.
const GROUND_SHADOW = /<ellipse cx="32" cy="60" rx="22" ry="2\.2" fill="#000" opacity="\.26" filter="url\(#[^"]+\)"\/>/g
const groundShadows = appIconBare.match(GROUND_SHADOW) ?? []
if (groundShadows.length !== 2) {
  throw new Error(`app-icon.svg: expected 2 ground shadows (light and dark), found ${groundShadows.length}`)
}
const appIconOnPage = appIconBare.replace(GROUND_SHADOW, '')

// The monochrome icon (issue #432) is a silhouette: the system keeps only its
// alpha and paints the shape in its own colour. The bare subject's elements drawn
// at partial opacity (the blurred ground shadow, the 14% plaza disc inside the
// ring and the shaft's highlight) would come out as faint grey shapes, the shadow
// a smudge under the ring at 48px, so this one render hides them (an opacity
// attribute below 1 starts with "0" or ".") and draws the rest black.
const SILHOUETTE_CSS = 'svg { filter: brightness(0); } svg [opacity^="0"], svg [opacity^="."] { display: none; }'

// app-icon.svg's two colourway groups, for the brand mark (issue #433). A group
// holds nested <g>s, so its end is found by counting tags rather than by a lazy
// match.
const appIconSvgTag = appIcon.match(/^<svg\b[^>]*>/)?.[0]
if (!appIconSvgTag) throw new Error('app-icon.svg: expected to start with an <svg> tag')

function colourwayGroup(svg, name) {
  const open = `<g class="${name}">`
  const start = svg.indexOf(open)
  if (start === -1 || svg.includes(open, start + 1)) {
    throw new Error(`app-icon.svg: expected exactly one ${open} group`)
  }
  const tags = /<g[\s>]|<\/g>/g
  tags.lastIndex = start
  let depth = 0
  for (let tag = tags.exec(svg); tag; tag = tags.exec(svg)) {
    depth += tag[0] === '</g>' ? -1 : 1
    if (depth === 0) return svg.slice(start + open.length, tag.index)
  }
  throw new Error(`app-icon.svg: ${open} is never closed`)
}

const baseStyle = `
  html, body { margin: 0; padding: 0; }
  body { overflow: hidden; }
  svg { display: block; }
`

// A square page with `svg` centred at `glyph` px on `background`, plus any `css`.
function iconPage({ size, glyph, background, svg, css = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    body { width: ${size}px; height: ${size}px; background: ${background};
           display: flex; align-items: center; justify-content: center; }
    svg { width: ${glyph}px; height: ${glyph}px; }
    ${css}
  </style></head><body>${svg}</body></html>`
}

// The subject sits straight on the card's ground: no tile inside a tile.
function ogPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    ${cardFontFaces}
    body { width: 1200px; height: 630px; background: ${GOLD_GROUND};
           font-family: '${CARD_FAMILY}', ${FONT_STACK}; -webkit-font-smoothing: antialiased; }
    .card { position: absolute; inset: 0; box-sizing: border-box; padding: 0 88px;
            display: flex; align-items: center; gap: 48px; }
    .glyph { flex: none; width: 340px; height: 340px; }
    .glyph svg { width: 100%; height: 100%; }
    .copy { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
    .name { margin: 0; color: ${INK}; font-size: 104px; font-weight: 800;
            letter-spacing: -0.03em; line-height: 1; }
    .name span { color: #FFFFFF; }
    .tagline { margin: 0; color: ${INK_SOFT}; font-size: 32px; font-weight: 600; line-height: 1.35; }
    .domain { margin: 0; color: ${INK_DOMAIN}; font-size: 26px; font-weight: 700; letter-spacing: 0.04em; }
  </style></head><body><div class="card">
    <div class="glyph">${appIconBare}</div>
    <div class="copy">
      <h1 class="name">Boiler<span>Indy</span></h1>
      <p class="tagline">${TAGLINE}</p>
      <p class="domain">boilerindy.app</p>
    </div>
  </div></body></html>`
}

// The cards for the pages students share (docs/share-links.md): og-image.png's
// ground and faces, the brand small above the page's own headline, and on the
// right an ink plate drawn like the page. No card says a hall is open: the
// feed's hours are unreliable (docs/dining.md, "Weekend hours").
const PLATE = 380 // .plate below, at the card's right padding, centred vertically
const PLATE_GOLD = '#FFC94A'
const PLATE_TEXT = '#F3F4F6'
// The bus and dining icons of components/Icons.tsx, stroked in gold.
const plateIcon = (paths) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="${PLATE_GOLD}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
const BUS_ICON = plateIcon(
  '<path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"/><path d="M4 10h16"/>' +
    `<circle cx="7.5" cy="14" r="1.5" fill="${PLATE_GOLD}" stroke="none"/><circle cx="16.5" cy="14" r="1.5" fill="${PLATE_GOLD}" stroke="none"/>` +
    '<path d="M6 18v2"/><path d="M18 18v2"/><path d="M8 4v2"/><path d="M16 4v2"/>',
)
const DINING_ICON = plateIcon(
  '<path d="M3 3v7c0 1.1.9 2 2 2h3v9a1 1 0 002 0V12h3a2 2 0 002-2V3"/><path d="M7 3v5"/>' +
    '<path d="M19 3v18a1 1 0 01-1 1h0a1 1 0 01-1-1v-6h-1a2 2 0 01-2-2V5c0-1.1.9-2 2-2h3z"/>',
)
// The JAGLINE routes as lib/transitShared.ts colours them, each number in the
// ink or white the app's onRouteColor picks for it.
const ROUTE_SQUARES = [
  ['1', '#990000', '#FFFFFF'],
  ['2', '#83786F', '#0A0B0E'],
  ['3', '#F1BE48', '#0A0B0E'],
  ['4', '#006298', '#FFFFFF'],
  ['5', '#66435A', '#FFFFFF'],
  ['7', '#E68217', '#0A0B0E'],
]

function pageCard({ headline, sub, domain, plate }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    ${cardFontFaces}
    body { width: 1200px; height: 630px; background: ${GOLD_GROUND};
           font-family: '${CARD_FAMILY}', ${FONT_STACK}; -webkit-font-smoothing: antialiased; }
    .card { position: absolute; inset: 0; box-sizing: border-box; padding: 0 88px;
            display: flex; align-items: center; gap: 56px; }
    .copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 22px; }
    .brand { display: flex; align-items: center; gap: 12px; margin: 0 0 4px; color: ${INK};
             font-size: 38px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
    .brand svg { width: 60px; height: 60px; }
    .brand .indy { color: #FFFFFF; }
    .headline { margin: 0; color: ${INK}; font-size: 84px; font-weight: 800; letter-spacing: -0.035em; line-height: 1.02; }
    .sub { margin: 0; color: ${INK_SOFT}; font-size: 32px; font-weight: 600; line-height: 1.3; text-wrap: balance; }
    .domain { margin: 4px 0 0; color: ${INK_DOMAIN}; font-size: 26px; font-weight: 700; letter-spacing: 0.04em; }
    .plate { flex: none; box-sizing: border-box; width: ${PLATE}px; height: ${PLATE}px; padding: 36px;
             border-radius: 36px; background: ${INK}; box-shadow: 0 18px 40px rgba(26, 18, 6, 0.28);
             display: flex; flex-direction: column; justify-content: center; gap: 28px; }
    .plate-head { display: flex; align-items: center; justify-content: space-between; height: 52px; }
    .icon { width: 52px; height: 52px; }
    .live { display: flex; align-items: center; gap: 10px; color: ${PLATE_TEXT};
            font-size: 22px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
    .live::before { content: ''; width: 14px; height: 14px; border-radius: 50%; background: #22C55E; }
    .routes { display: grid; grid-template-columns: repeat(3, 92px); gap: 16px; }
    .route { display: grid; place-items: center; width: 92px; height: 92px; border-radius: 12px;
             font-size: 46px; font-weight: 800; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.16); }
    .meals { display: flex; flex-direction: column; gap: 14px; }
    .meal { display: flex; align-items: center; height: 64px; box-sizing: border-box; padding: 0 28px;
            border-radius: 32px; border: 2px solid rgba(243, 244, 246, 0.28); color: ${PLATE_TEXT};
            font-size: 30px; font-weight: 700; }
    .meal.on { background: ${PLATE_GOLD}; border-color: ${PLATE_GOLD}; color: ${INK}; }
  </style></head><body><div class="card">
    <div class="copy">
      <p class="brand">${appIconBare}<span>Boiler<span class="indy">Indy</span></span></p>
      <h1 class="headline">${headline}</h1>
      <p class="sub">${sub}</p>
      <p class="domain">${domain}</p>
    </div>
    <div class="plate">${plate}</div>
  </div></body></html>`
}

const TRANSIT_CARD = pageCard({
  headline: 'Live campus<br>bus map',
  sub: 'Every JAGLINE shuttle, stop by stop.',
  domain: 'boilerindy.app/transit',
  plate: `<div class="plate-head">${BUS_ICON}<span class="live">Live</span></div>
    <div class="routes">${ROUTE_SQUARES.map(([num, fill, text]) => `<span class="route" style="background:${fill};color:${text}">${num}</span>`).join('')}</div>`,
})

const DINING_CARD = pageCard({
  headline: 'Today&rsquo;s<br>dining menu',
  sub: 'Every meal, with diet labels and dish details.',
  domain: 'boilerindy.app/dining',
  plate: `<div class="plate-head">${DINING_ICON}</div>
    <div class="meals"><span class="meal">Breakfast</span><span class="meal on">Lunch</span><span class="meal">Dinner</span></div>`,
})

// A point on the plate's left padding, clear of anything drawn on it.
const plateInkAt = [1200 - 88 - PLATE + 24, 315, 'ink']
const PAGE_CARD_FONTS = [`800 84px "${CARD_FAMILY}"`, `600 32px "${CARD_FAMILY}"`, `700 26px "${CARD_FAMILY}"`]

const maskableGlyph = Math.round(512 * (1 - 2 * MASKABLE_SAFE_PADDING))

// One point, in the source's 64-unit tile, that the subject must cover however
// the tile is placed: the monument's shaft.
const INK_AT = [32, 30]
const inkAt = (size, glyph, expected = 'ink') => {
  const off = (size - glyph) / 2
  return [Math.round(off + (INK_AT[0] / 64) * glyph), Math.round(off + (INK_AT[1] / 64) * glyph), expected]
}
const OG_GLYPH = 340 // .glyph in ogPage(), left at the card's 88px padding, centred vertically
const ogInkAt = [88 + Math.round((INK_AT[0] / 64) * OG_GLYPH), Math.round((630 - OG_GLYPH) / 2 + (INK_AT[1] / 64) * OG_GLYPH), 'ink']

// `checks` as for ASSETS below, in tile units (a copy is drawn at 64px): the
// corner, the left edge where the tile was and the spot under the ring where its
// shadow was are all bare page now, and INK_AT on the shaft is ink on the light
// copy and gold on the dark one.
const BRAND_MARKS = [
  { file: 'brand/mark-light.svg', group: 'light', checks: [[0, 0, 'transparent'], [6, 32, 'transparent'], [32, 61, 'transparent'], [...INK_AT, 'ink']] },
  { file: 'brand/mark-dark.svg', group: 'dark', checks: [[0, 0, 'transparent'], [6, 32, 'transparent'], [32, 61, 'transparent'], [...INK_AT, 'gold']] },
].map((mark) => ({ ...mark, svg: `${appIconSvgTag}\n<g>${colourwayGroup(appIconOnPage, mark.group)}</g>\n</svg>\n` }))

// `checks` sample the written PNG: [x, y, expected] where expected is
// 'transparent', 'gold' (any pixel of the gold ground, no subject there),
// 'ink' (the dark subject) or 'opaque' (any alpha 255).
const ASSETS = [
  {
    file: 'apple-touch-icon.png',
    width: 180,
    height: 180,
    html: iconPage({ size: 180, glyph: 180, background: GOLD_B, svg: appIconFullBleed }),
    omitBackground: false,
    checks: [[0, 0, 'gold'], [179, 0, 'gold'], inkAt(180, 180)],
  },
  {
    file: 'icons/icon-192.png',
    width: 192,
    height: 192,
    html: iconPage({ size: 192, glyph: 192, background: 'transparent', svg: appIcon }),
    omitBackground: true,
    checks: [[0, 0, 'transparent'], inkAt(192, 192)],
  },
  {
    file: 'icons/icon-512.png',
    width: 512,
    height: 512,
    html: iconPage({ size: 512, glyph: 512, background: 'transparent', svg: appIcon }),
    omitBackground: true,
    checks: [[0, 0, 'transparent'], inkAt(512, 512)],
  },
  {
    file: 'icons/icon-512-maskable.png',
    width: 512,
    height: 512,
    html: iconPage({ size: 512, glyph: maskableGlyph, background: GOLD_GROUND, svg: appIconBare }),
    omitBackground: false,
    // Corners and the safe-padding band must be plain ground; the subject sits mid-tile.
    checks: [[0, 0, 'gold'], [511, 511, 'gold'], [50, 256, 'gold'], inkAt(512, maskableGlyph)],
  },
  {
    file: 'icons/icon-512-monochrome.png',
    width: 512,
    height: 512,
    html: iconPage({ size: 512, glyph: maskableGlyph, background: 'transparent', svg: appIconBare, css: SILHOUETTE_CSS }),
    omitBackground: true,
    // Same inset as the maskable icon, with nothing but the subject drawn.
    checks: [[0, 0, 'transparent'], [511, 511, 'transparent'], [50, 256, 'transparent'], inkAt(512, maskableGlyph, 'opaque')],
  },
  {
    file: 'og-image.png',
    width: 1200,
    height: 630,
    html: ogPage(),
    omitBackground: false,
    // The wordmark, the tagline and the domain line, as ogPage() sets them.
    fonts: [`800 104px "${CARD_FAMILY}"`, `600 32px "${CARD_FAMILY}"`, `700 26px "${CARD_FAMILY}"`],
    checks: [[0, 0, 'gold'], [1199, 629, 'gold'], ogInkAt],
  },
  {
    file: 'og-transit.png',
    width: 1200,
    height: 630,
    html: TRANSIT_CARD,
    omitBackground: false,
    fonts: PAGE_CARD_FONTS,
    checks: [[0, 0, 'gold'], [1199, 629, 'gold'], plateInkAt],
  },
  {
    file: 'og-dining.png',
    width: 1200,
    height: 630,
    html: DINING_CARD,
    omitBackground: false,
    fonts: PAGE_CARD_FONTS,
    checks: [[0, 0, 'gold'], [1199, 629, 'gold'], plateInkAt],
  },
]

function pngDimensions(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(signature) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG')
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] }
}

// Decode the written PNG in the browser and sample pixels via a canvas.
async function samplePixels(page, buf, points) {
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
  return page.evaluate(
    async ({ dataUrl, points }) => {
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data))
    },
    { dataUrl, points },
  )
}

function matchesExpectation(expected, [r, g, b, a]) {
  switch (expected) {
    case 'transparent':
      return a === 0
    case 'gold':
      // anywhere on the #FFC94A to #E08A12 gradient, and nothing drawn over it
      return a === 255 && r >= 200 && g >= 120 && g <= 210 && b <= 90
    case 'ink':
      // the shaded #4E3A1C to #120B04 subject
      return a === 255 && r <= 90 && g <= 70 && b <= 45
    case 'opaque':
      return a === 255
    default:
      throw new Error(`unknown expectation ${expected}`)
  }
}

async function main() {
  await mkdir(path.join(PUBLIC_DIR, 'icons'), { recursive: true })

  const browser = await chromium.launch({ timeout: 120_000 })
  const failures = []
  try {
    // Light, so the adaptive sources draw their light colourway whatever the
    // machine running this script is set to.
    const context = await browser.newContext({ deviceScaleFactor: 1, colorScheme: 'light' })
    const page = await context.newPage()

    for (const asset of ASSETS) {
      const outPath = path.join(PUBLIC_DIR, asset.file)
      await page.setViewportSize({ width: asset.width, height: asset.height })
      await page.setContent(asset.html, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)
      if (asset.fonts) {
        // load() resolves with the faces it matched; none means the family is not
        // declared at all, where check() alone would answer true.
        const missing = await page.evaluate(async (fonts) => {
          const out = []
          for (const font of fonts) {
            const faces = await document.fonts.load(font).catch(() => [])
            if (faces.length === 0 || !document.fonts.check(font)) out.push(font)
          }
          return out
        }, asset.fonts)
        if (missing.length) throw new Error(`${asset.file}: font not loaded, nothing written: ${missing.join(', ')}`)
      }
      await page.screenshot({ path: outPath, omitBackground: asset.omitBackground, type: 'png' })

      const buf = await readFile(outPath)
      const dims = pngDimensions(buf)
      const samples = await samplePixels(page, buf, asset.checks.map(([x, y]) => [x, y]))
      const problems = []
      if (dims.width !== asset.width || dims.height !== asset.height) {
        problems.push(`expected ${asset.width}x${asset.height}, got ${dims.width}x${dims.height}`)
      }
      asset.checks.forEach(([x, y, expected], i) => {
        if (!matchesExpectation(expected, samples[i])) {
          problems.push(`pixel (${x},${y}) expected ${expected}, got rgba(${samples[i].join(',')})`)
        }
      })
      const status = problems.length ? 'FAIL' : 'ok'
      console.log(
        `${status.padEnd(4)} ${asset.file.padEnd(28)} ${dims.width}x${dims.height} ` +
          `colorType=${dims.colorType} ${(buf.length / 1024).toFixed(1)} KiB`,
      )
      for (const p of problems) {
        console.log(`     - ${p}`)
        failures.push(`${asset.file}: ${p}`)
      }
    }

    // The brand mark copies ship as SVG text: each is written, read back and
    // drawn as an <img> at 64px on transparent, and that screenshot is sampled.
    for (const mark of BRAND_MARKS) {
      const outPath = path.join(PUBLIC_DIR, mark.file)
      await mkdir(path.dirname(outPath), { recursive: true })
      await writeFile(outPath, mark.svg)

      const written = await readFile(outPath)
      const src = `data:image/svg+xml;base64,${written.toString('base64')}`
      await page.setViewportSize({ width: 64, height: 64 })
      await page.setContent(
        iconPage({ size: 64, glyph: 64, background: 'transparent', svg: `<img src="${src}" width="64" height="64" alt="">` }),
        { waitUntil: 'load' },
      )
      const shot = await page.screenshot({ omitBackground: true, type: 'png' })
      const samples = await samplePixels(page, shot, mark.checks.map(([x, y]) => [x, y]))
      const problems = mark.checks.flatMap(([x, y, expected], i) =>
        matchesExpectation(expected, samples[i]) ? [] : [`pixel (${x},${y}) expected ${expected}, got rgba(${samples[i].join(',')})`],
      )
      console.log(`${(problems.length ? 'FAIL' : 'ok').padEnd(4)} ${mark.file.padEnd(28)} drawn at 64x64 ${(written.length / 1024).toFixed(1)} KiB`)
      for (const p of problems) {
        console.log(`     - ${p}`)
        failures.push(`${mark.file}: ${p}`)
      }
    }
  } finally {
    await browser.close()
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`\nRendered ${ASSETS.length} assets and split ${BRAND_MARKS.length} brand marks into ${PUBLIC_DIR}`)
}

await main()
