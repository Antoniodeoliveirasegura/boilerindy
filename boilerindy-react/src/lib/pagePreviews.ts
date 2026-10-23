// Link previews for the pages students share (the Share buttons,
// docs/share-links.md). A chat app builds its card from the HTML it fetches
// and never runs the app, so every address used to unfurl as the one card in
// index.html. The build (vite.config.js) writes a copy of index.html per page
// with that page's title, description and image, and vercel.json rewrites the
// page's path to its copy ahead of the SPA fallback. No page here may promise
// that a hall is open: the feed's hours are unreliable (docs/dining.md,
// "Weekend hours").
//
// vite.config.js imports this file, so it imports nothing itself: the config
// loader wants every import spelled with its extension, and src/ spells none.

export const SITE_URL = 'https://www.boilerindy.app'

export type PagePreview = {
  /** The route shared. */
  path: string
  /** The copy of index.html the build writes into dist/, which vercel.json rewrites `path` to. */
  file: string
  title: string
  description: string
  /** Under public/, 1200x630 like og-image.png, rendered by scripts/render-icons.mjs. */
  image: string
  imageAlt: string
}

/** One per page with a Share button (lib/shareLinks.ts). */
export const PAGE_PREVIEWS: Record<'transit' | 'dining' | 'free-food', PagePreview> = {
  transit: {
    path: '/transit',
    file: 'transit.html',
    title: 'JAGLINE live bus map - BoilerIndy',
    description: 'Every JAGLINE shuttle on a live map, stop by stop. Free for Purdue Indianapolis students, no sign-in needed.',
    image: '/og-transit.png',
    imageAlt: 'BoilerIndy live bus map, with the JAGLINE route colours',
  },
  dining: {
    path: '/dining',
    file: 'dining.html',
    title: "Today's campus dining menu - BoilerIndy",
    description: "Today's campus dining menus, meal by meal, with diet labels and dish details. Free for Purdue Indianapolis students, no sign-in needed.",
    image: '/og-dining.png',
    imageAlt: "BoilerIndy dining menu, with today's meals",
  },
  // One card for the list and for a single event's link: a card naming the
  // event would have to be built per request.
  'free-food': {
    path: '/free-food',
    file: 'free-food.html',
    title: 'Free food on campus - BoilerIndy',
    description: 'Upcoming campus events with free food: pizza, snacks, coffee and more, from the campus calendars. Free for Purdue Indianapolis students, no sign-in needed.',
    image: '/og-free-food.png',
    imageAlt: 'BoilerIndy free food list, with upcoming campus events',
  },
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Every meta tag a page's copy rewrites. The image size and the card type
// stay as index.html has them: every card is 1200x630.
const META: { attribute: 'name' | 'property'; key: string; value: (page: PagePreview) => string }[] = [
  { attribute: 'name', key: 'description', value: (p) => p.description },
  { attribute: 'property', key: 'og:title', value: (p) => p.title },
  { attribute: 'property', key: 'og:description', value: (p) => p.description },
  { attribute: 'property', key: 'og:url', value: (p) => `${SITE_URL}${p.path}` },
  { attribute: 'property', key: 'og:image', value: (p) => `${SITE_URL}${p.image}` },
  { attribute: 'property', key: 'og:image:alt', value: (p) => p.imageAlt },
  { attribute: 'name', key: 'twitter:title', value: (p) => p.title },
  { attribute: 'name', key: 'twitter:description', value: (p) => p.description },
  { attribute: 'name', key: 'twitter:image', value: (p) => `${SITE_URL}${p.image}` },
]

const REWRITES: { pattern: RegExp; tag: (page: PagePreview) => string }[] = [
  { pattern: /<title>[^<]*<\/title>/g, tag: (p) => `<title>${escapeAttribute(p.title)}</title>` },
  ...META.map(({ attribute, key, value }) => ({
    pattern: new RegExp(`<meta ${attribute}="${key}" content="[^"]*"\\s*/?>`, 'g'),
    tag: (p: PagePreview) => `<meta ${attribute}="${key}" content="${escapeAttribute(value(p))}" />`,
  })),
]

/**
 * `indexHtml` (the built index.html) as `page`'s link preview: the same page
 * with its own title, description, address and image. Throws when a tag is
 * missing or repeated, so a change to index.html stops the build rather than
 * quietly sending every shared link back to the home card.
 */
export function pagePreviewHtml(indexHtml: string, page: PagePreview): string {
  let html = indexHtml
  for (const { pattern, tag } of REWRITES) {
    const found = html.match(pattern)?.length ?? 0
    if (found !== 1) throw new Error(`index.html: expected one ${pattern.source}, found ${found} (link preview for ${page.path})`)
    html = html.replace(pattern, () => tag(page))
  }
  return html
}
