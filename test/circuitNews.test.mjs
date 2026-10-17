// Campus news from The Circuit (issue #470): headline, date, tag, author and
// the paper's own excerpt, each linking to the article, and never the article
// itself. The fixture is the real feed of 2026-10-17 cut to those fields: no
// content:encoded, no media:content, no images.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CIRCUIT_FEED_URL, EXCERPT_CHARS, MAX_POSTS, cutExcerpt, fetchCircuitNews, parseCircuitRss } from '../src/circuitNews.mjs'

const FEED = readFileSync(new URL('./fixtures/circuit-rss.xml', import.meta.url), 'utf8')

test('the fixture holds headers and excerpts only, never an article body or an image', () => {
  assert.ok(!FEED.includes('content:encoded'))
  assert.ok(!FEED.includes('media:content'))
  assert.ok(!FEED.includes('<img'))
})

test('parseCircuitRss reads each post\'s headline, link, date, first tag, author and excerpt', () => {
  const posts = parseCircuitRss(FEED)
  assert.equal(posts.length, 5)
  assert.deepEqual(posts[0], {
    title: 'A Look Inside The Academic Success Building',
    url: 'https://circuitpress.org/a-look-inside-the-academic-success-building/',
    publishedAt: '2026-10-01T04:24:51.000Z',
    author: 'Omkar Govil-Nair',
    tag: 'News',
    excerpt: "We toured the construction site of the Academic Success Building. Learn about what spaces the building will and won't have.",
  })
  assert.equal(posts[2].title, 'Fall 2026 Club Guide')
  assert.equal(posts[2].tag, 'Student Orgs')
  // Entities decode: the headline is "Q&A", not "Q&amp;A".
  assert.equal(posts[1].title, 'Q&A with the Senior Vice Provost of Purdue in Indianapolis')
  assert.ok(posts.every((p) => p.excerpt.length <= EXCERPT_CHARS + 1))
})

test('the full article and its images are never read, even when the feed carries them', () => {
  const item = `<item><title><![CDATA[Story]]></title><link>https://circuitpress.org/story/</link>
    <description><![CDATA[<p>The excerpt.</p>]]></description>
    <content:encoded><![CDATA[<p>The whole article, which must stay on their site.</p>]]></content:encoded>
    <media:content url="https://circuitpress.org/content/images/photo.jpg" medium="image"/></item>`
  const [post] = parseCircuitRss(`<rss><channel>${item}</channel></rss>`)
  assert.equal(post.excerpt, 'The excerpt.')
  assert.ok(!JSON.stringify(post).includes('whole article'))
  assert.ok(!JSON.stringify(post).includes('photo.jpg'))
})

test('only circuitpress.org links survive, untitled posts are dropped, and the list is capped', () => {
  const items = [
    '<item><title>Elsewhere</title><link>https://example.com/story/</link></item>',
    '<item><title>Plain http</title><link>http://circuitpress.org/story/</link></item>',
    '<item><title></title><link>https://circuitpress.org/untitled/</link></item>',
    ...Array.from({ length: 12 }, (_, i) => `<item><title>Post ${i}</title><link>https://circuitpress.org/p${i}/</link><pubDate>nonsense</pubDate></item>`),
  ]
  const posts = parseCircuitRss(`<rss><channel>${items.join('')}</channel></rss>`)
  assert.equal(posts.length, MAX_POSTS)
  assert.equal(posts[0].title, 'Post 0')
  assert.equal(posts[0].publishedAt, null)
  assert.equal(posts[0].author, null)
  assert.deepEqual(parseCircuitRss(null), [])
})

test('cutExcerpt cuts at a word with an ellipsis', () => {
  const long = 'If I could give one piece of advice to every incoming Purdue University in Indianapolis student, it would be to get involved early, find your people, ask for help when you need it and keep an eye on the deadlines that sneak up on you, because the semester moves faster than anyone expects.'
  assert.ok(long.length > EXCERPT_CHARS)
  const cut = cutExcerpt(long)
  assert.ok(cut.endsWith('…'))
  assert.ok(cut.length <= EXCERPT_CHARS + 1)
  assert.ok(long.startsWith(cut.slice(0, -1)))
  assert.equal(cutExcerpt('Short.'), 'Short.')
})

test('fetchCircuitNews reads the feed politely and throws on a failed answer, so the cache keeps the last list', async () => {
  const calls = []
  const ok = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, text: async () => FEED }
  }
  const now = new Date('2026-10-17T06:30:00Z')
  const news = await fetchCircuitNews({ fetchImpl: ok, now })
  assert.equal(news.ok, true)
  assert.equal(news.source, 'The Circuit')
  assert.equal(news.site, 'https://circuitpress.org/')
  assert.equal(news.fetchedAt, now.toISOString())
  assert.equal(news.posts.length, 5)
  assert.equal(calls[0].url, CIRCUIT_FEED_URL)
  assert.match(calls[0].init.headers['User-Agent'], /BoilerIndy/)

  const down = async () => ({ ok: false, status: 503, text: async () => '' })
  await assert.rejects(fetchCircuitNews({ fetchImpl: down }), /answered 503/)
})
