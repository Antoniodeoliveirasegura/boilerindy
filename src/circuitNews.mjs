// Campus news from The Circuit (issue #470), Purdue Indy's student newspaper:
// an independent, volunteer, student-run paper at https://circuitpress.org/,
// published on Ghost with an RSS feed at /rss/.
//
// The paper states no license or reuse terms, so its content is all rights
// reserved. This module keeps only what a headline list may show: the
// headline, the date, the first tag, the author and the paper's own excerpt,
// each with a link back to the article. The feed also carries every article's
// full HTML (content:encoded) and feature images (media:content); neither is
// ever read. Full text or images need the paper's permission, the owner's call.
//
// Shape, like src/parkingStatus.mjs: a pure parser (feed XML in, posts out)
// and a fetch shell with an injectable fetch. The server caches the result for
// an hour through its shared stale-on-failure cache (src/routes/campus.mjs).

export const CIRCUIT_SITE = 'https://circuitpress.org/'
export const CIRCUIT_FEED_URL = 'https://circuitpress.org/rss/'
export const CIRCUIT_NAME = 'The Circuit'
// Excerpts are cut at a word to about this length.
export const EXCERPT_CHARS = 240
export const MAX_POSTS = 8
const FETCH_TIMEOUT_MS = 10_000
const USER_AGENT = 'BoilerIndy campus app (+https://www.boilerindy.app)'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** The text of a tag's content: CDATA unwrapped, tags stripped, entities decoded, whitespace collapsed. */
function textOf(raw) {
  if (raw == null) return ''
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw)
  const inner = cdata ? cdata[1] : raw
  return decodeEntities(inner.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** The first `<name>...</name>` inside an item, or null. Names are matched exactly, so `link` never reads `atom:link`. */
function firstTag(item, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`).exec(item)
  return m ? m[1] : null
}

/** An excerpt cut at a word to EXCERPT_CHARS, with an ellipsis when cut. */
export function cutExcerpt(text, max = EXCERPT_CHARS) {
  if (!text) return ''
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const atWord = cut.lastIndexOf(' ')
  return `${(atWord > max * 0.6 ? cut.slice(0, atWord) : cut).replace(/[\s,.;:]+$/, '')}…`
}

/** Only links to the paper's own articles survive. */
function articleUrl(raw) {
  const url = textOf(raw)
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'circuitpress.org' ? parsed.toString() : null
  } catch {
    return null
  }
}

/**
 * The feed's posts, newest first as the feed lists them, at most MAX_POSTS:
 * [{ title, url, publishedAt, author, tag, excerpt }]. A post without a
 * headline or a circuitpress.org link is dropped. Never reads content:encoded
 * or media:content.
 */
export function parseCircuitRss(xml) {
  if (typeof xml !== 'string') return []
  const posts = []
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const item = match[1]
    const title = textOf(firstTag(item, 'title'))
    const url = articleUrl(firstTag(item, 'link'))
    if (!title || !url) continue
    const date = new Date(textOf(firstTag(item, 'pubDate')))
    posts.push({
      title,
      url,
      publishedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      author: textOf(firstTag(item, 'dc:creator')) || null,
      tag: textOf(firstTag(item, 'category')) || null,
      excerpt: cutExcerpt(textOf(firstTag(item, 'description'))) || null,
    })
    if (posts.length >= MAX_POSTS) break
  }
  return posts
}

/**
 * Fetch and parse the feed: { ok: true, source, site, fetchedAt, posts }.
 * Throws on a network error, a timeout or a non-200 answer, so the server's
 * cache keeps serving the last good list and tries again shortly.
 */
export async function fetchCircuitNews({ fetchImpl = globalThis.fetch, now = new Date(), feedUrl = CIRCUIT_FEED_URL } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(feedUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.1' },
    })
    if (!res.ok) throw new Error(`The Circuit feed answered ${res.status}`)
    const posts = parseCircuitRss(await res.text())
    return { ok: true, source: CIRCUIT_NAME, site: CIRCUIT_SITE, fetchedAt: now.toISOString(), posts }
  } finally {
    clearTimeout(timer)
  }
}
