// Renders the PNG launch assets from public/favicon.svg (issue #155).
//
//   node scripts/render-icons.mjs        (run from boilerindy-react/)
//   pnpm run render-icons
//
// Outputs, all under public/:
//   apple-touch-icon.png          180x180, opaque #100b04 ground (iOS ignores alpha)
//   icons/icon-192.png            192x192, transparent, manifest purpose "any"
//   icons/icon-512.png            512x512, transparent, manifest purpose "any"
//   icons/icon-512-maskable.png   512x512, glyph inset 20% on #100b04, purpose "maskable"
//   og-image.png                  1200x630 social preview card (Open Graph / Twitter)
//
// Headless Chromium (Playwright, already a workspace dev dependency for e2e) is
// launched exactly once; every asset is rendered, written and then read back and
// pixel-checked in that same session. No external fonts: the card uses the
// platform's system sans, so the exact glyph shapes vary slightly by OS.

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url))

const GROUND = '#100b04' // app background / theme-color
const GOLD = '#D4A84B' // --color-gold in src/index.css
const GOLD_MUTED = '#B8943F' // --color-gold-muted
const OFF_WHITE = '#F2ECDF'
const TAGLINE = 'Your Purdue Indianapolis campus companion - schedule, dining, transit, board, and more.'
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const MASKABLE_SAFE_PADDING = 0.2 // fraction of each edge kept clear of the glyph

const svg = await readFile(path.join(PUBLIC_DIR, 'favicon.svg'), 'utf8')

const baseStyle = `
  html, body { margin: 0; padding: 0; }
  body { overflow: hidden; }
  svg { display: block; }
`

// A square page with the favicon glyph centred at `glyph` px on `background`.
function iconPage({ size, glyph, background }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    body { width: ${size}px; height: ${size}px; background: ${background};
           display: flex; align-items: center; justify-content: center; }
    svg { width: ${glyph}px; height: ${glyph}px; }
  </style></head><body>${svg}</body></html>`
}

function ogPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}
    body { width: 1200px; height: 630px; background: ${GROUND};
           font-family: ${FONT_STACK}; -webkit-font-smoothing: antialiased; }
    .card { position: absolute; inset: 0; box-sizing: border-box; padding: 0 88px;
            display: flex; align-items: center; gap: 64px; }
    .glyph { flex: none; width: 300px; height: 300px; }
    .glyph svg { width: 100%; height: 100%; }
    .copy { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    .name { margin: 0; color: ${GOLD}; font-size: 104px; font-weight: 700;
            letter-spacing: -0.02em; line-height: 1; }
    .tagline { margin: 0; color: ${OFF_WHITE}; font-size: 34px; line-height: 1.35; }
    .domain { margin: 0; color: ${GOLD_MUTED}; font-size: 26px; letter-spacing: 0.04em; }
  </style></head><body><div class="card">
    <div class="glyph">${svg}</div>
    <div class="copy">
      <h1 class="name">BoilerIndy</h1>
      <p class="tagline">${TAGLINE}</p>
      <p class="domain">boilerindy.app</p>
    </div>
  </div></body></html>`
}

const maskableGlyph = Math.round(512 * (1 - 2 * MASKABLE_SAFE_PADDING))

// `checks` sample the written PNG: [x, y, expected] where expected is
// 'transparent', 'ground' (the opaque #100b04 ground), or 'opaque' (any alpha 255).
const ASSETS = [
  {
    file: 'apple-touch-icon.png',
    width: 180,
    height: 180,
    html: iconPage({ size: 180, glyph: 180, background: GROUND }),
    omitBackground: false,
    checks: [[0, 0, 'ground'], [90, 90, 'opaque']],
  },
  {
    file: 'icons/icon-192.png',
    width: 192,
    height: 192,
    html: iconPage({ size: 192, glyph: 192, background: 'transparent' }),
    omitBackground: true,
    checks: [[0, 0, 'transparent'], [96, 96, 'opaque']],
  },
  {
    file: 'icons/icon-512.png',
    width: 512,
    height: 512,
    html: iconPage({ size: 512, glyph: 512, background: 'transparent' }),
    omitBackground: true,
    checks: [[0, 0, 'transparent'], [256, 256, 'opaque']],
  },
  {
    file: 'icons/icon-512-maskable.png',
    width: 512,
    height: 512,
    html: iconPage({ size: 512, glyph: maskableGlyph, background: GROUND }),
    omitBackground: false,
    // Corner and the safe-padding band must be the plain ground colour.
    checks: [[0, 0, 'ground'], [50, 256, 'ground'], [256, 256, 'opaque']],
  },
  {
    file: 'og-image.png',
    width: 1200,
    height: 630,
    html: ogPage(),
    omitBackground: false,
    checks: [[0, 0, 'ground'], [1199, 629, 'ground'], [600, 315, 'opaque']],
  },
]

function pngDimensions(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(signature) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG')
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
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
  const ground = hexToRgb(GROUND)
  const near = (v, t) => Math.abs(v - t) <= 2
  switch (expected) {
    case 'transparent':
      return a === 0
    case 'ground':
      return a === 255 && near(r, ground[0]) && near(g, ground[1]) && near(b, ground[2])
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
    const context = await browser.newContext({ deviceScaleFactor: 1 })
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
  } finally {
    await browser.close()
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`\nRendered ${ASSETS.length} assets into ${PUBLIC_DIR}`)
}

await main()
