# Shared campus events on /events and /free-food

Issue #30, rollout step 4 of [shared-campus-events.md](shared-campus-events.md):
the read path. The rows the ingest writes to `campus_events`
([campus-events-ingest.md](campus-events-ingest.md)) are listed on the Events
and Free Food pages for every student, a student with no linked calendar
included. Off by default behind `CAMPUS_EVENTS_FEED`; with it off every
response is what it was before.

## Turning it on (owner)

1. Run README step 43, read the dry run and schedule step 44, as
   [campus-events-ingest.md](campus-events-ingest.md#turning-it-on-owner)
   says, and let one real run fill the table (or start one with the curl there,
   without `?dryRun=1`).
2. Set `CAMPUS_EVENTS_FEED=on` on Render and redeploy.
3. Open `/events` with an account that has no linked calendar: the campus
   events are listed, each with a "Purdue event" or "IU event" label, and the
   details card links out to the listing.

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
it can never be taken for one of the student's `calendar_items`:

```json
{ "id": "campus:5b8c...", "sourceId": null, "title": "United Way Chili and Dessert Cook-off",
  "description": "...", "startTime": "2026-10-19T15:00:00.000Z", "endTime": "2026-10-19T17:00:00.000Z",
  "location": "Campus Center 450", "category": "campus_event", "externalUid": null, "sourceType": "campus",
  "allDay": false, "freeFood": false, "shared": true, "sourceKey": "iu_events", "sourceLabel": "IU event",
  "sourceUrl": "https://events.iu.edu/event/..." }
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
1,300 with it on.

## Known limits

- A multi-day LiveWhale row ends where the ingest's 31-day window does, so
  "until ..." can come before an exhibit's real closing day.
- An event a student's own feed also carries (a career fair in a Brightspace
  calendar, sorted into `campus_event` by the title regex in
  `src/scheduleSync.mjs`) is listed twice. Retiring that regex is rollout
  step 5.
- The Events page's "Get Picks" recommendations still read the student's own
  calendar through the assistant, not the shared rows.
