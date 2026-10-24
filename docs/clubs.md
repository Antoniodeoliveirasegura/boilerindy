# Club Directory

A searchable directory of Purdue student organizations (issue #16, the
"club directory" path): the `/clubs` page and the `GET /api/clubs` endpoint
behind it. Indianapolis groups come first, and every card deep-links to the
organization's BoilerLink page for events, membership and contacts. A
signed-in student can follow clubs, and the followed clubs' events get their
own filter on `/events` and `/free-food` ([Following a club](#following-a-club)).

## Where the data comes from

BoilerLink (https://boilerlink.purdue.edu) is Purdue's Anthology Engage
instance. Its organizations search is a public JSON API with no key and no
login:

    https://boilerlink.purdue.edu/api/discovery/search/organizations?top=300&skip=0&orderBy[0]=UpperName asc

It returns `{ "@odata.count": N, "value": [...] }` with, per organization,
`Id`, `Name`, `ShortName`, `WebsiteKey`, `ProfilePicture`, `Description`
(HTML), `Summary` (plain text, about 250 characters), `CategoryNames`,
`Status` and `Visibility`. About 1,200 active public orgs, 36 categories,
1.9 MB in total (checked 2026-09-08). Two derived URLs:

- Organization page: `https://boilerlink.purdue.edu/organization/<WebsiteKey>`
- Logo: `https://se-images.campuslabs.com/clink/images/<ProfilePicture>?preset=med-sq`
  (170x170 JPEG, about 5 KB; `small-sq` is 75x75)

Club events come from the same site: BoilerLink's public event search
(`/api/discovery/event/search`; the probes in #16 tried paths that only serve
the SPA shell) feeds the shared campus events ingest when
`CAMPUS_EVENTS_ENGAGE` names `boilerlink`, and the Events page lists the
Indianapolis ones (`docs/campus-events-ingest.md`). Purdue's Student
Activities and Organizations agreed on 2026-10-18 to BoilerIndy reading the
event search, in reply to an email that also described this directory's
reading of the organizations list.

The API is unofficial in the sense that nothing guarantees its shape, which is
why the normalizer is fixture-tested and the endpoint degrades instead of
failing.

## Pipeline

- `src/boilerlinkClubs.mjs` is the pure core plus the shell:
  - `normalizeOrganization(raw)` trims names, decodes entities, strips the
    HTML description to text, builds the page and logo URLs, and produces a
    `blurb` (the summary, else the first 280 characters of the description).
    Rows without an id, name or `WebsiteKey`, or not Active + Public, are
    dropped.
  - `buildClubDirectory(rows)` sorts by folded name, dedupes ids, counts
    categories (overall and for Indianapolis) and prepares the search index.
  - `searchClubDirectory(directory, params)` filters by scope and category,
    matches the query and pages the result.
  - `fetchClubDirectory()` pages through the API (first page for the count,
    the rest in parallel, 300 per page, 15 s timeout) and never throws.
  - `createClubDirectoryCache()` keeps the last good directory in memory.
- `src/routes/campus.mjs` serves `GET /api/clubs` through the `clubs-read`
  rate limiter (300 requests per 15 minutes per IP, its own bucket so
  search-as-you-type does not eat the live transit / dining budget);
  `server.mjs` builds the cache and warms it five seconds after boot.
- `boilerindy-react/src/lib/clubs.ts` holds the client types and helpers;
  `pages/Clubs.tsx` is the page. Services links to it from the Campus Life
  card and the In-App Shortcuts tile.
- Following a club: `src/routes/clubFollows.mjs` (the routes),
  `src/clubFollows.mjs` (the directory lookups and the follows read the
  calendar uses), `db/supabase-club-follows.sql` (README step 48).

## The API

`GET /api/clubs?q=&category=&scope=&page=&pageSize=`

| Param | Meaning | Default |
|---|---|---|
| `q` | Free text, up to 100 characters. Every word has to match somewhere. | none |
| `category` | Exact category name, case-insensitive. | none |
| `scope` | `all` or `indianapolis`. | `all` |
| `page` | 1-based, clamped to the last page. | `1` |
| `pageSize` | 1 to 100. | `24` |

Response: `{ ok, error?, source, sourceUrl, fetchedAt, stale, directoryTotal,
indianapolisTotal, q, category, scope, page, pageSize, pages, total, clubs,
categories }`. Each club is `{ id, name, shortName, slug, url, imageUrl,
blurb, categories, indianapolis }`; `categories` lists every category in the
whole directory as `{ name, count, indianapolisCount }` so the filter menu can
show counts for either scope. `Cache-Control: public, max-age=300`.

The page defaults to `scope=indianapolis`; the API defaults to everything.

## Search semantics

Text is folded before matching: NFKC normalization (so the "mathematical
bold" letters some orgs decorate their summaries with match plain typing),
lowercase, diacritics removed (`Pokémon` matches `pokemon`), punctuation
collapsed to spaces. Ranking: a club whose name (or short name or slug)
contains the whole phrase comes first, then clubs whose name contains every
word, then clubs where every word appears in the categories or blurb. Ties
keep alphabetical order.

## The Indianapolis rule

BoilerLink covers every Purdue campus and most organizations meet in West
Lafayette. A club is flagged `indianapolis: true` when:

1. its name or short name contains "Indianapolis", "Indy" or "IUPUI" (56 of
   about 1,200 orgs, all genuine on review), or
2. its summary or description uses a campus phrasing: "Purdue Indianapolis",
   "Purdue University in Indianapolis", "Indianapolis campus", "campus in
   Indianapolis", or "based / located / organization / club / chapter / team /
   students in Indianapolis".

Plain mentions of the city do not count ("Riley Hospital for Children in
Indianapolis", "founded at Butler University in Indianapolis", "Eagle Creek
near Indianapolis" are all West Lafayette orgs). The page explains this next to
the toggle so nobody reads the flag as an official campus assignment.

## Caching and degraded mode

- TTL `BOILERLINK_CLUBS_CACHE_MS`, default 6 hours, floor 5 minutes. A fresh
  copy is served as-is; once the TTL passes, the old copy is served
  immediately (`stale: true`) while one background refresh runs. Concurrent
  callers share a single upstream fetch.
- A failed refresh keeps the last good directory and holds off upstream for a
  minute before trying again. A page that fails mid-way degrades the whole
  fetch rather than serving a partial list.
- With no good copy at all (BoilerLink down since boot) the endpoint answers
  `ok: false, error, clubs: []` for a minute at a time and the page shows the
  outage banner with a direct link to BoilerLink.

## Following a club

A signed-in student follows a club from its card on `/clubs`. The follows are
kept with the account in `club_follows` (README step 48,
`db/supabase-club-follows.sql`), so they show on every device, and deleting
the account deletes them through the foreign key on `users(id)`. A followed
club's events get the "Clubs I follow" pill on `/events` and `/free-food`.

### Keys

A club is named by its organization key, `boilerlink:<Id>`: the club's `id`
from `GET /api/clubs`, BoilerLink's organization `Id`, a positive integer. The
ingest stores the same key on every BoilerLink event as
`campus_events.organization_key` (`thespot:<Id>` on TheSpot, `NULL` for the
Purdue and IU calendars; `organizationKeyFor` and `parseOrganizationKey` in
`src/sharedEvents.mjs`). A Purdue calendar row that absorbed the same event
from BoilerLink keeps the club's key, so the event still counts as the club's.
Only BoilerLink clubs can be followed: TheSpot has no club directory.

### Routes

All three need a session; the two writes are behind `user-write`
([RATE_LIMITS.md](RATE_LIMITS.md)), and the cap is 100 clubs a student
(`MAX_CLUB_FOLLOWS` in `src/userWriteCaps.mjs`). The key goes in the path as is
or with the colon encoded (`boilerlink%3A401442`).

| Route | Answer |
|---|---|
| `GET /api/me/club-follows` | `{ "follows": ["boilerlink:401442"], "clubs": [{ ...club, "organizationKey": "boilerlink:401442" }] }`: every key followed, oldest first, and the followed clubs the directory lists, in its name order, each the `GET /api/clubs` club with its key. A club that left BoilerLink stays in `follows` and is not in `clubs`; with BoilerLink down since boot `clubs` is empty. |
| `PUT /api/me/club-follows/:organizationKey` | `{ "ok": true, "organizationKey": "boilerlink:401442", "following": true }`. Idempotent: following a club already followed answers the same and keeps the first follow. The club must be in the directory. |
| `DELETE /api/me/club-follows/:organizationKey` | `{ "ok": true, "organizationKey": "boilerlink:401442", "following": false }`. Idempotent, and it reads no directory, so a club that left BoilerLink can still be unfollowed. |

Every other answer uses the standard envelope
([api-error-codes.md](api-error-codes.md)):

| Status | Code | When |
|---|---|---|
| 400 | `club_follows_bad_key` | PUT or DELETE with a key that is not `boilerlink:<Id>` or `thespot:<Id>`. |
| 404 | `club_follows_unknown_club` | PUT for a club the directory does not list: gone from BoilerLink, or a TheSpot club. |
| 409 | `club_follows_limit` | PUT for a new club when the student already follows 100. |
| 503 | `club_follows_directory_unavailable` | PUT while BoilerLink has not answered since the server started. |
| 503 | `club_follows_schema_missing` | Any of the three before README step 48. |
| 500 | none | Any other database failure, with a fixed message. |

401 without a session and 429 from `user-write` are as on every other route.

### The followed clubs' events

`GET /api/me/calendar?shared=1` and `GET /api/me/events` read the student's
follows alongside the shared campus events (`readFollowedKeys` in
`src/clubFollows.mjs`), and every shared row gains two fields, the others
unchanged ([campus-events-feed.md](campus-events-feed.md#clubs-i-follow)):

- `organizationKey`: the club that listed it, or `null`;
- `followed`: `true` when the student follows that club, else `false`. It is
  left out, rather than `false`, when the follows cannot be read (README step
  48 not run, a failed read), so a client can tell "not followed" from "not
  known". The signed-out `GET /api/campus-events/free-food` never carries it.

### The page

Once the follows have loaded, every card has a Follow toggle (`aria-pressed`)
that flips at once and is undone, with the server's reason, when the write is
refused. "Following (n)" beside the campus pills opens the Following view
(`?following=1`): the followed clubs from `GET /api/me/club-follows`, narrowed
by the same search box and category menu in the browser. There is no follow UI
signed out, while the follows load, or when `GET /api/me/club-follows` answers
`club_follows_schema_missing`; another failure says so with Try again.

### Turning it on (owner)

1. Run `db/supabase-club-follows.sql` in the Supabase SQL Editor (README step
   48). There is no setting: the routes and the pills work from the next
   request.
2. Let the next ingest run fill `campus_events.organization_key` (every 6
   hours), or start one with the curl in
   [campus-events-ingest.md](campus-events-ingest.md#the-dry-run), without
   `?dryRun=1`. Its summary says `"organizationKeys": "written"`.
3. Follow a club with an upcoming BoilerLink event on `/clubs`, then open
   `/events` and pick Clubs I follow.

Until step 48 runs nothing breaks: the ingest writes its rows without the
column, answers `"organizationKeys": "column_missing"` and logs once
`[club_follows] schema missing: run db/supabase-club-follows.sql ...`; the
calendar reads list every row as before with `organizationKey: null` and no
`followed`; `/clubs` shows no follow UI.

## Configuration

```bash
BOILERLINK_CLUBS_URL=        # override the source (e.g. a local fixture server); default is the BoilerLink API
BOILERLINK_CLUBS_CACHE_MS=   # cache TTL in ms; default 21600000 (6 h), floor 300000
RATE_LIMIT_CLUBS_READ_MAX=   # see docs/RATE_LIMITS.md
```

## Tests

- `test/boilerlinkClubs.test.mjs`: normalization against
  `test/fixtures/boilerlink-organizations.json` (13 real rows covering
  leading spaces, a trailing-space category, a missing logo, a missing
  description, an accented name and Indianapolis-only-in-description cases),
  the Indianapolis rule, search and paging, the paged fetch shell with an
  injected fetch, and the cache with a fake clock.
- `boilerindy-react/src/lib/clubs.test.ts`: query building, initials, labels,
  and the follow helpers (the key, the follows answer, the Following view's
  filter and labels).
- `e2e/clubs.spec.js`: the page against the mocked API (default scope, the
  toggle, category and text filters in the URL, "Show more", the outage
  banner, the way in from Services).
- Following: `test/routes/clubFollows.test.mjs` (auth, the limiter, key
  checks, idempotence, the cap, an unknown club, the directory down, a missing
  table), `test/clubFollows.test.mjs`, the `organization_key` cases in
  `test/sharedEvents.test.mjs` and `test/campusEventsIngest.test.mjs`, the
  `followed` cases in `test/campusEventsFeed.test.mjs` and
  `test/calendarReads.test.mjs`, `boilerindy-react/src/pages/Clubs.test.tsx`,
  the pill in `Events.test.tsx` and `FreeFood.test.tsx`, and
  `e2e/club-follows.spec.js`.

## Follow-ups

- Club events ride on the shared campus events ingest (above); a club page of
  its own events would be the next step.
- For followed clubs (issue #16): a push when a followed club posts a new
  event, off by default, through the reminder runner; the followed clubs'
  events in the subscribable calendar feed; the native app's Clubs screen,
  on the routes above. A club that left BoilerLink stays in `follows` and
  counts toward the 100 until unfollowed; the website lists only the clubs
  the directory has, so it offers no way to unfollow one.
