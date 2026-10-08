// Renders the PNG launch assets from public/app-icon.svg (issues #155, #408) and
// splits the in-app brand mark out of public/favicon.svg (#433).
//
//   node scripts/render-icons.mjs        (run from boilerindy-react/)
//   pnpm run render-icons
//
// Sources, both under public/, both adaptive: one SVG holds a light and a dark
// colourway and shows the dark one under @media (prefers-color-scheme: dark).
//   app-icon.svg    Monument Circle: the monument on its thin ring, ink on a gold
//                   tile in light mode and gold on an ink tile in dark mode; the app
//                   icon at 60px and up
//   favicon.svg     the relief B in the same two colourways; browser tabs and 16 to
//                   32px contexts (served directly by index.html) and the in-app
//                   brand mark (below)
//
// The brand mark is split, not rendered: each colourway group of favicon.svg is
// copied out byte for byte, without the <style> that switches them, so
// components/BrandMark.tsx can follow the app's own theme class instead of the
// device setting. Both copies are drawn and pixel-checked like the PNGs.
//   brand/mark-light.svg          the light group: ink B on the gold tile
//   brand/mark-dark.svg           the dark group: gold B on the ink tile
//
// Outputs, all under public/, rendered from the light colourway: a home-screen
// tile is one PNG that cannot follow the device's appearance, and gold is canonical.
//   apple-touch-icon.png          180x180, full-bleed gold ground (iOS masks the corners itself)
//   icons/icon-192.png            192x192, rounded tile on transparent, manifest purpose "any"
//   icons/icon-512.png            512x512, rounded tile on transparent, manifest purpose "any"
//   icons/icon-512-maskable.png   512x512, subject inset 20% on the full-bleed gold ground, purpose "maskable"
//   og-image.png                  1200x630 social preview card (Open Graph / Twitter)
//
// Headless Chromium (Playwright, already a workspace dev dependency for e2e) is
// launched exactly once, in a light colour-scheme context; every asset is
// rendered, written and then read back and pixel-checked in that same session.
// No external fonts: the card uses the platform's system sans, so the exact glyph
// shapes vary slightly by OS.

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

// favicon.svg's two colourway groups (issue #433). A group holds nested <g>s, so
// its end is found by counting tags rather than by a lazy match.
const favicon = await readFile(path.join(PUBLIC_DIR, 'favicon.svg'), 'utf8')
const faviconSvgTag = favicon.match(/^<svg\b[^>]*>/)?.[0]
if (!faviconSvgTag) throw new Error('favicon.svg: expected to start with an <svg> tag')

function colourwayGroup(svg, name) {
  const open = `<g class="${name}">`
  const start = svg.indexOf(open)
  if (start === -1 || svg.includes(open, start + 1)) {
    throw new Error(`favicon.svg: expected exactly one ${open} group`)
  }
  const tags = /<g[\s>]|<\/g>/g
  tags.lastIndex = start
  let depth = 0
  for (let tag = tags.exec(svg); tag; tag = tags.exec(svg)) {
    depth += tag[0] === '</g>' ? -1 : 1
    if (depth === 0) return svg.slice(start + open.length, tag.index)
  }
  throw new Error(`favicon.svg: ${open} is never closed`)
}

// `checks` as for ASSETS below, in tile units (a copy is drawn at 64px): outside
// the rounded corner, the ground at the left edge, the B's stem. Gold and ink
// trade places between the two colourways.
const BRAND_MARKS = [
  { file: 'brand/mark-light.svg', group: 'light', checks: [[0, 0, 'transparent'], [6, 32, 'gold'], [20, 32, 'ink']] },
  { file: 'brand/mark-dark.svg', group: 'dark', checks: [[0, 0, 'transparent'], [6, 32, 'ink'], [20, 32, 'gold']] },
].map((mark) => ({ ...mark, svg: `${faviconSvgTag}\n<g>${colourwayGroup(favicon, mark.group)}</g>\n</svg>\n` }))

const baseStyle = `
  html, body { margin: 0; padding: 0; }
  body { overflow: hidden; }
  svg { display: block; }
`

// A square page with `svg` centred at `glyph` px on `background`.
function iconPage({ size, glyph, background, svg }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    body { width: ${size}px; height: ${size}px; background: ${background};
           display: flex; align-items: center; justify-content: center; }
    svg { width: ${glyph}px; height: ${glyph}px; }
  </style></head><body>${svg}</body></html>`
}

// The subject sits straight on the card's ground: no tile inside a tile.
function ogPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    body { width: 1200px; height: 630px; background: ${GOLD_GROUND};
           font-family: ${FONT_STACK}; -webkit-font-smoothing: antialiased; }
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

const maskableGlyph = Math.round(512 * (1 - 2 * MASKABLE_SAFE_PADDING))

// One point, in the source's 64-unit tile, that the subject must cover however
// the tile is placed: the monument's shaft.
const INK_AT = [32, 30]
const inkAt = (size, glyph) => {
  const off = (size - glyph) / 2
  return [Math.round(off + (INK_AT[0] / 64) * glyph), Math.round(off + (INK_AT[1] / 64) * glyph), 'ink']
}
const OG_GLYPH = 340 // .glyph in ogPage(), left at the card's 88px padding, centred vertically
const ogInkAt = [88 + Math.round((INK_AT[0] / 64) * OG_GLYPH), Math.round((630 - OG_GLYPH) / 2 + (INK_AT[1] / 64) * OG_GLYPH), 'ink']

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
    file: 'og-image.png',
    width: 1200,
    height: 630,
    html: ogPage(),
    omitBackground: false,
    checks: [[0, 0, 'gold'], [1199, 629, 'gold'], ogInkAt],
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
