# Campus News

The latest headlines from The Circuit, Purdue Indy's student newspaper
(issue #470): the "Campus news" dashboard widget, a link on `/clubs` to the
paper's newest Student Orgs story, and the `GET /api/campus-news` endpoint
behind both.

## Where the data comes from

The Circuit (`https://circuitpress.org/`) is an independent, volunteer,
student-run paper published on Ghost. Its RSS feed lists the recent posts:

    https://circuitpress.org/rss/

On 2026-10-17 it answered 200 with about 92 KB of `application/rss+xml`: five
posts since 2026-08-01, tagged News, Campus Life, Student Orgs, Opinion or
From the Editors. Each item also carries the full article HTML
(`content:encoded`) and the feature image (`media:content`). Ghost has a
read-only Content API too, but its key is the paper's own, embedded in their
pages for site search, and can rotate, so the feed is the source.

## What is shown, and why

The site states no license or reuse terms (its about, standards and ethics
pages and its footer, checked 2026-10-17), so its content is all rights
reserved. BoilerIndy shows only what a list of headlines needs, each post
linking back to the paper:

- the headline, linking to the article on circuitpress.org in a new tab;
- the date, the first tag and the author;
- the paper's own excerpt (the feed's `description`), cut at a word to about
  240 characters and clamped to two lines on screen.

It never shows the article text or the photos. The parser never reads
`content:encoded` or `media:content`, and the test fixture holds no article
bodies or images. Showing either needs the paper's permission, which is the
owner's call (`contact@circuitpress.org`) and outside issue #470.

## Pipeline

- `src/circuitNews.mjs` is the pure core, shaped like
  `src/parkingStatus.mjs`: `parseCircuitRss(xml)` keeps each item's `title`,
  `link`, `pubDate`, `dc:creator`, first `category` and `description` (HTML
  stripped, entities decoded), drops any post without a headline or an
  `https://circuitpress.org/` link, and returns at most eight.
  `fetchCircuitNews()` is the fetch shell: a 10 s timeout, a User-Agent that
  names the app, and a throw on a network error, a timeout or a non-200.
- `src/routes/campus.mjs` serves `GET /api/campus-news`, a session-free public
  read registered ahead of the session middleware (the `public-read-ip` and
  `public-read` limiters, see [RATE_LIMITS.md](RATE_LIMITS.md)). It goes
  through `server.mjs`'s shared cache (`getCached`, key `news:circuit`) for an
  hour, so the paper sees at most one request an hour from each backend
  process, and answers with `Cache-Control: public, max-age=600,
  s-maxage=1800`.
- A failed refresh keeps serving the last good list (the shared cache retries
  a few seconds later, behind the edge's half hour). When the feed has never
  answered, the read returns `{ ok: false, error: 'campus_news_unavailable',
  posts: [] }` with `no-store` and leaves the feed alone for five minutes
  (`CAMPUS_NEWS_RETRY_MS`) before asking again.
- The browser only ever calls `/api/campus-news`, never circuitpress.org,
  until the student follows a link.

## The client

- `boilerindy-react/src/lib/campusNews.ts` holds the types and `postMeta`,
  the "Oct 1 · News · By ..." line (the date on the campus clock).
- `lib/queries/publicData.ts` reads it as `['news', 'circuit']`: fresh for 30
  minutes, an answer with `ok: false` stale at once so the next visit asks
  again, and persisted to localStorage with the other public reads
  ([client-cache.md](client-cache.md)).
- `components/dashboard/CampusNewsWidget.tsx` is the widget: up to four posts,
  then the credit line "From The Circuit, Purdue Indy's student newspaper",
  linking the paper's site. With no posts it says so in one line.
- `pages/Clubs.tsx` links the newest post tagged Student Orgs under the page
  header, when there is one (on 2026-10-17, the Fall 2026 Club Guide).

The widget id is `campus-news` in `src/dashboardLayout.mjs`: half width and
visible in the default layout, after the board. A saved layout gets a new
catalogue widget appended hidden (`normalizeLayout` in `src/widgetLayout.mjs`),
so students who already arranged their dashboard turn it on from Customize,
and new students see it.

## Response shape

```json
{
  "ok": true,
  "source": "The Circuit",
  "site": "https://circuitpress.org/",
  "fetchedAt": "2026-10-17T06:30:00.000Z",
  "posts": [
    {
      "title": "A Look Inside The Academic Success Building",
      "url": "https://circuitpress.org/a-look-inside-the-academic-success-building/",
      "publishedAt": "2026-10-01T04:24:51.000Z",
      "author": "Omkar Govil-Nair",
      "tag": "News",
      "excerpt": "The paper's own summary, cut at a word to about 240 characters..."
    }
  ]
}
```

`publishedAt`, `author`, `tag` and `excerpt` are `null` when the feed leaves
them out.

## Tests

- `test/circuitNews.test.mjs` runs the parser on
  `test/fixtures/circuit-rss.xml`, the real feed of 2026-10-17 trimmed to each
  item's `title`, `link`, `guid`, `category`, `dc:creator`, `pubDate` and
  `description`. To refresh it, save the feed and keep only those tags: never
  commit `content:encoded`, `media:content` or an image.
- `test/routes/campus.test.mjs` covers the route, its limiters, headers and
  the outage answer.
- `CampusNewsWidget.test.tsx`, `campusNews.test.ts` and `publicData.test.ts`
  cover the client; `e2e/dashboard.spec.js` and `e2e/clubs.spec.js` run with
  the read mocked in `e2e/fixtures/mock-backend.js`.
