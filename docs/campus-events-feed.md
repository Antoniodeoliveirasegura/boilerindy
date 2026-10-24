# Shared campus events on /events and /free-food

Issue #30, rollout step 4 of [shared-campus-events.md](shared-campus-events.md):
the read path. The rows the ingest writes to `campus_events`
([campus-events-ingest.md](campus-events-ingest.md)) are listed on the Events
and Free Food pages for every student, a student with no linked calendar
included, and the ones with free food on `/free-food` for a signed-out visitor
too ([Signed out](#signed-out), issue #366). Off by default behind
`CAMPUS_EVENTS_FEED`; with it off every response is what it was before.

## Turning it on (owner)

1. Run README step 43, read the dry run and schedule step 44, as
   [campus-events-ingest.md](campus-events-ingest.md#turning-it-on-owner)
   says, and let one real run fill the table (or start one with the curl there,
   without `?dryRun=1`).
2. Set `CAMPUS_EVENTS_FEED=on` on Render and redeploy.
3. Open `/events` with an account that has no linked calendar: the campus
   events are listed, each with a "Purdue event" or "IU event" label, and the
   details card links out to the listing. Then open `/free-food` in a private
   window: the ones with free food are listed under the preview bar.

Setting it back to `off` hides them on the next deploy. Nothing is written in
either direction.

## Which reads get them

`listCalendarItems` (`src/calendarReads.mjs`) merges the shared rows that
`src/campusEventsFeed.mjs` reads into the student's own, in start order, the
student's row first on a tie, and the read's `limit` counts both. Only two
reads ask:

| Read | Shared rows |
|---|---|
| `GET /api/me/calendar?shared=1` | The categories the read names, as `listCalendarItems` gives its own filter precedence (`category` over `categories`, none for both). The Events and Free Food window (`categories=campus_event,event,deadline&limit=500&shared=1`, `CAMPUS_EVENTS_CALENDAR` in `boilerindy-react/src/lib/queries/userData.ts`) gets both. |
| `GET /api/me/events` | Both categories, with the student's `event` rows. No page reads it today. |
| `GET /api/campus-events/free-food` | Both categories, the rows with free food alone, and no student's rows: the signed-out Free Food page's read, with no session ([Signed out](#signed-out)). |

Nothing else asks, so the Tasks page, Home, the assistant and the native app's
task list read exactly what they read before, and a shared row never reaches a
list that offers "mark done". The native app's Events screen gets them once it
adds `shared=1` to its read (a change in `boilerindy-app`).

## What is listed

| Rule | Detail |
|---|---|
| Not over | Its end, or for an all-day row with no end the end of its day, or else its start, is now or later. A row still running from an earlier day (a gallery exhibit) is listed under Today, its clock line saying until when, and the details card "On now · until ...". Both pages now treat the student's own rows the same way, so an event in progress stays listed until it ends. |
| Fresh | Written by the ingest within the last 26 hours: four missed 6-hourly runs and two hours' grace. An older row belongs to a source that has been failing for a day, and may have been cancelled or moved since. |
| Reachable | `venue_kind` is not `west_lafayette` or `elsewhere` (Mackey Arena, an Indianapolis club's away game). `online` and `unknown` are listed. |
| Open | `open_to_all` is not `false` (a practice, a rehearsal, an officer meeting, and with Jev on an event for staff or instructors). `NULL` is listed. |
| Once per series | One row per `series_key`, its next occurrence, so a weekly class is listed once. |
| Category | `deadline` (Purdue's "Dates and Deadlines") reads as Deadline, every other row as Campus Event. |
| Free food | The stored `free_food`: the source's own tag, free entry with food in the listing, or the keyword matcher, which Jev's answer replaces with `CAMPUS_EVENTS_CLASSIFY` on ([campus-events-ingest.md](campus-events-ingest.md#jev-classification)). |

Each listed row carries `shared: true`, a source label and the listing's link,
http(s) only. The labels are `SOURCE_LABELS` in `src/campusEventsFeed.mjs`:
"Purdue event", "IU event", "BoilerLink" and "TheSpot (IU)". IU Indianapolis's
own listings are open to Purdue Indianapolis students (the owner's call on #30,
2026-10-18) and keep the "IU event" label to say where they come from. A shared
row's id is `campus:` and the table's id, so
it can never be taken for one of the student's `calendar_items`. Since issue
#16 a row also says which club listed it (`organizationKey`, `null` for the
Purdue and IU calendars) and, on a student's read, whether the student follows
that club (`followed`, see [Clubs I follow](#clubs-i-follow)):

```json
{ "id": "campus:5b8c...", "sourceId": null, "title": "United Way Chili and Dessert Cook-off",
  "description": "...", "startTime": "2026-10-19T15:00:00.000Z", "endTime": "2026-10-19T17:00:00.000Z",
  "location": "Campus Center 450", "category": "campus_event", "externalUid": null, "sourceType": "campus",
  "allDay": false, "freeFood": false, "shared": true, "sourceKey": "iu_events", "sourceLabel": "IU event",
  "sourceUrl": "https://events.iu.edu/event/...", "organizationKey": null, "followed": false }
```

On the 2026-10-17 fixtures (`test/campusEventsFeed.test.mjs`) the 31 rows the
ingest plans list as 26: two away games, two club practices and the second
Yoga class of the day are left out (the medical school's journal club and
Faculty Crossing's writing session no longer reach the table; see
`docs/campus-events-ingest.md`).

Both pages filter by source once their rows come from two sources or more:
All sources, Purdue (Purdue's calendar and BoilerLink), IU (IU's calendar and
TheSpot) and My calendar (the student's own rows), each pill with its count, by
`sourceKey` (`components/EventSourceFilter.tsx`, `lib/campusEvents.ts`). Events
counts over every row, as its category pills do; Free Food over its free-food
list. A pick whose source runs out of rows falls back to All sources.

## Clubs I follow

Issue #16: a student follows clubs on `/clubs` ([clubs.md](clubs.md#following-a-club)),
and both pages then offer "Clubs I follow (n)" after the source pills, the
events of those clubs alone. The server marks them:
`listSharedCalendarItems` reads the student's `club_follows` alongside the
shared rows, and every row says `followed: true` or `false` by its
`organizationKey`. Marking never changes which rows are listed.

- The pill shows whenever the shared rows carry `followed`, even at 0, since
  its empty state links to `/clubs` ("Find clubs to follow"). The source pills
  keep their own rule (two sources or more), so a page with one source shows
  All sources and Clubs I follow alone.
- `followed` is left out, and so is the pill, when the follows cannot be read:
  before README step 48, or when the read fails (logged as `club_follows read:`
  on every read, or the step 48 file once when the table is missing). The
  signed-out read never carries it, and the signed-out Free Food page never
  shows the pill.
- Following or unfollowing on `/clubs` refetches the calendar windows, so the
  pill is current the next time either page opens.
- Cost: one more query per Events or Free Food load, of the student's
  follows by the primary key, at most 100 rows. The shared rows' read asks for
  `organization_key` too, and asks again without it while step 48 has not
  added the column.

## Signed out

`/free-food` is open to signed-out visitors (the public preview, issue #366,
listed in `boilerindy-react/src/lib/publicPreview.ts`), so a link to it can be
shared before anyone has an account. A visitor has no calendar to read, so the
page reads `GET /api/campus-events/free-food` (`src/routes/campusEvents.mjs`):
`{ "ok": true, "items": [...] }`, the rows above in the same shape, by the
same rules, narrowed to the ones with free food.

- It reads `campus_events` alone, with `free_food = true` in the query and
  again in the plan (`readPublicFreeFoodRows` and `planPublicFreeFoodItems` in
  `src/campusEventsFeed.mjs`), so neither a row from a student's
  `calendar_items` nor a row without free food can be in the answer.
- It is registered ahead of the session middleware, with the `public-read` and
  `public-read-ip` limiters ([RATE_LIMITS.md](RATE_LIMITS.md)): it never sees
  a session or sets a cookie, and the answer is the same for every caller, so
  it carries `Cache-Control: public, max-age=60, s-maxage=300,
  stale-while-revalidate=600`.
- One read of the rows serves the server process for a minute, through the
  shared stale cache (`getCached` in `server.mjs`), so the database sees at
  most a read a minute however many visitors arrive. The rows are planned per
  request, so a row drops out once it is over, and when a later read fails the
  last good rows are served.
- A failed first read is never an empty list: `503`
  `campus_events_schema_missing` when the table is missing (step 43 not run),
  otherwise `500` with "Could not load free food events. Please try again.",
  both with `Cache-Control: no-store`. The page then says campus events did
  not load and offers a retry.
- With `CAMPUS_EVENTS_FEED` off it answers `{ "ok": true, "items": [] }` and
  reads nothing, as the signed-in pages then list no shared rows either.

The signed-out page shows the All sources, Purdue and IU pills (never My
calendar), and nothing that needs an account: no "Connect a calendar source"
card and no link to `/events`. The per-user calendar read waits until the
session is known, and the public one runs only once it is known to be absent,
so neither a visitor nor a signed-in student on a cold load is sent to
`/login`.

Neither page shows the sponsor side rails (`lib/adFreeRoutes.ts`, read by
`AppLayout`): Ticketmaster's API terms bar deriving revenue from the use of its
API, and these are the pages its listings would reach. Home's sponsored widget
and featured deal never show shared rows, since Home's calendar read leaves out
`shared=1`.

## When the read fails

The shared rows only add to a student's own calendar, so they never fail the
read: without them `listCalendarItems` answers the student's rows alone, and
`GET /api/me/calendar` still answers 500 only when the student's own read
fails.

- A missing table (step 43 not run while the switch is on) logs
  `[campus_events] schema missing: run db/supabase-campus-events.sql in the
  Supabase SQL Editor, then retry.` once per process.
- Any other failure logs `campus_events read:` with the database code and
  message on every read.

## Cost

One more query per Events or Free Food load, which the client caches for 30
seconds (`docs/client-cache.md`): the fresh, reachable, open rows that end from
now on, at most 3,000 (`SHARED_EVENTS_MAX_ROWS`), paged past PostgREST's
max-rows. That was 299 rows on 2026-10-17 with Engage off, and would be about
1,300 with it on. The signed-out read adds at most one query a minute per
server process, of the rows with free food only (5 listed on 2026-10-17), at
most 500 (`PUBLIC_FREE_FOOD_MAX_ROWS`), in one page.

## Known limits

- A multi-day LiveWhale row ends where the ingest's 31-day window does, so
  "until ..." can come before an exhibit's real closing day.
- An event a student's own feed also carries (a career fair in a Brightspace
  calendar, sorted into `campus_event` by the title regex in
  `src/scheduleSync.mjs`) is listed twice. Retiring that regex is rollout
  step 5.
- The Events page's "Get Picks" recommendations still read the student's own
  calendar through the assistant, not the shared rows.
- A series is listed once, but the two Free Food reads pick its row in a
  different order. Signed in, the page takes the series' next occurrence and
  then keeps it only if it has free food; signed out, the read keeps the rows
  with free food and then takes the next of those. In a series where only a
  later occurrence has free food, the signed-out page lists it and the
  signed-in one does not. On the 2026-10-17 fixtures the two lists are the
  same five rows (`test/campusEventsFeed.test.mjs`).
