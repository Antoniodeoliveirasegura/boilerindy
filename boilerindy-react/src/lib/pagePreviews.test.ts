import { describe, expect, test } from 'vitest'
import indexHtml from '../../index.html?raw'
import vercel from '../../vercel.json'
import { PAGE_PREVIEWS, SITE_URL, pagePreviewHtml, type PagePreview } from './pagePreviews'

// Link previews for the shared pages (docs/share-links.md): every address used
// to unfurl as the home card, because a chat app reads the HTML it fetches
// and never runs the app.

const pages = Object.values(PAGE_PREVIEWS)

function meta(html: string, attribute: string, key: string): string | undefined {
  return html.match(new RegExp(`<meta ${attribute}="${key}" content="([^"]*)"`))?.[1]
}

describe('a page preview', () => {
  test.each(pages)('$path gets its own title, description, address and image', (page) => {
    const html = pagePreviewHtml(indexHtml, page)

    expect(html).toContain(`<title>${page.title}</title>`)
    expect(meta(html, 'name', 'description')).toBe(page.description)
    expect(meta(html, 'property', 'og:title')).toBe(page.title)
    expect(meta(html, 'property', 'og:description')).toBe(page.description)
    expect(meta(html, 'property', 'og:url')).toBe(`${SITE_URL}${page.path}`)
    expect(meta(html, 'property', 'og:image')).toBe(`${SITE_URL}${page.image}`)
    expect(meta(html, 'property', 'og:image:alt')).toBe(page.imageAlt)
    expect(meta(html, 'name', 'twitter:title')).toBe(page.title)
    expect(meta(html, 'name', 'twitter:description')).toBe(page.description)
    expect(meta(html, 'name', 'twitter:image')).toBe(`${SITE_URL}${page.image}`)
    // Nothing of the home card is left in a tag (a comment still names its image).
    expect(html).not.toMatch(/content="[^"]*og-image\.png"/)
    expect(html).not.toMatch(/content="[^"]*campus companion/)
    expect(html).not.toMatch(/<title>[^<]*campus app/)
  })

  test('changes only those tags, so the copy runs the same app', () => {
    const before = indexHtml.split('\n')
    for (const page of pages) {
      const after = pagePreviewHtml(indexHtml, page).split('\n')
      expect(after).toHaveLength(before.length)
      const changed = before.filter((line, i) => line !== after[i])
      expect(changed).toHaveLength(10)
      for (const line of changed) {
        expect(line).toMatch(/<title>|<meta (name|property)="(description|og:(title|description|url|image|image:alt)|twitter:(title|description|image))"/)
      }
    }
  })

  test('stops the build when index.html loses or repeats a tag it rewrites', () => {
    const withoutImage = indexHtml.replace(/<meta property="og:image" content="[^"]*" \/>/, '')
    expect(() => pagePreviewHtml(withoutImage, PAGE_PREVIEWS.transit)).toThrow(/og:image.*found 0/)
    expect(() => pagePreviewHtml(indexHtml.replace('</head>', '<title>Again</title></head>'), PAGE_PREVIEWS.dining)).toThrow(
      /title.*found 2/,
    )
  })

  test('escapes the copy for the attribute it goes in', () => {
    const page: PagePreview = { ...PAGE_PREVIEWS.dining, title: 'Mac & "cheese" <today>' }
    const html = pagePreviewHtml(indexHtml, page)
    expect(meta(html, 'property', 'og:title')).toBe('Mac &amp; &quot;cheese&quot; &lt;today&gt;')
    expect(html).toContain('<title>Mac &amp; &quot;cheese&quot; &lt;today&gt;</title>')
  })

  // The status of a hall is the feed's guess, and its hours are unreliable
  // (docs/dining.md, "Weekend hours"): a card stays up in a chat for days.
  test('never says a hall is open', () => {
    for (const page of pages) expect(`${page.title} ${page.description} ${page.imageAlt}`).not.toMatch(/\bopen\b|hours/i)
  })
})

describe('vercel.json', () => {
  test('rewrites each shared page to its preview copy, ahead of the SPA fallback', () => {
    const { rewrites } = vercel
    const fallback = rewrites.findIndex((r) => r.source === '/(.*)')
    expect(fallback).toBe(rewrites.length - 1)
    for (const page of pages) {
      const at = rewrites.findIndex((r) => r.source === page.path)
      expect(at, page.path).toBeGreaterThanOrEqual(0)
      expect(at).toBeLessThan(fallback)
      expect(rewrites[at].destination).toBe(`/${page.file}`)
    }
  })

  // Headers match the address asked for, before any rewrite, so the copies
  // are served under the same policy as every other page.
  test('keeps the site-wide security headers on every path', () => {
    const everyPath = vercel.headers.find((h) => h.source === '/(.*)')?.headers ?? []
    const csp = everyPath.find((h) => h.key === 'Content-Security-Policy')?.value ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(everyPath.find((h) => h.key === 'X-Frame-Options')?.value).toBe('DENY')
  })
})

describe('the card images', () => {
  const images = import.meta.glob<string>('../../public/og-*.png', { query: '?inline', import: 'default', eager: true })

  // og:image:width and og:image:height stay as index.html has them.
  test.each(pages)('$image is a 1200x630 PNG', (page) => {
    const dataUrl = images[`../../public${page.image}`]
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    const header = atob(dataUrl.split(',')[1].slice(0, 44))
    const uint32 = (at: number) => [0, 1, 2, 3].reduce((n, i) => n * 256 + header.charCodeAt(at + i), 0)
    expect(header.slice(12, 16)).toBe('IHDR')
    expect([uint32(16), uint32(20)]).toEqual([1200, 630])
  })
})
