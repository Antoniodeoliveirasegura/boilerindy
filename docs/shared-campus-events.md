# Shared campus events (design)

Status: rollout steps 1 to 4 are built. The sources are chosen (below), the
table is `db/supabase-campus-events.sql`, and the ingest, with its dry run, is
`POST /api/internal/campus-events/ingest` ([campus-events-ingest.md](campus-events-ingest.md)).
The read path (step 4) lists the table on `/events` and `/free-food` behind
`CAMPUS_EVENTS_FEED`, off by default ([campus-events-feed.md](campus-events-feed.md)).

## The problem

Campus events today are not shared. Every row in `calendar_items` has a
`user_id NOT NULL` and a `source_id NOT NULL`, so an event exists only for the
student whose own feed happened to contain it. The `campus_event` category is
assigned by a regex over each student's private feed
(`src/scheduleSync.mjs:42`), matching titles like `career fair`, `workshop`,
`info session`, `call out`.

Two consequences:

1. The same career fair is stored once per student who imported it, with no
   relationship between the copies.
2. A student who has not linked a feed, or whose feed does not carry the event,
   cannot see it at all. An event is only as discoverable as the private
   calendars it happens to appear in, which is the opposite of what a campus
   events page is for.

## Decision: public sources only

Shared events are sourced from **public Purdue Indianapolis feeds**, never from
students' Brightspace or timetable calendars.

This is a hard constraint, not a default. A Brightspace calendar is a personal
academic record: the student's class sections, assignment due dates, and exam
times. Promoting rows out of it into a table every user reads would publish one
student's schedule to the whole campus. The classifier that would decide what
gets promoted is a title regex, and a regex cannot distinguish "ECE Career Fair"
from "CS 250 Exam 2 Review Session". That is not a tuning problem; personal
feeds are the wrong input.

Rejected alternatives, recorded so they are not revisited by accident:

- **Promote from student feeds automatically.** Publishes private academic data.
  No consent, and the regex gate is not a safety boundary.
- **Promote from student feeds with an opt-in checkbox.** Better, but the
  checkbox still asks a student to reason about what a calendar entry reveals
  (course enrolment, exam schedule) at the moment they are least likely to think
  about it. Revisit only if public sources prove insufficient, and only with
  per-event review rather than a blanket toggle.

## Open question: which public feed (settled 2026-10-17)

Settled by a live check of every candidate on 2026-10-17 (issues #16 and #30).
The repo had no public events source before. `src/purdueCalendarAutomation.mjs`
drives the *personal* timetable export at `timetable.mypurdue.purdue.edu`,
which sits behind login and Duo and was never a candidate.

Option 2 of the order below won: both official campus calendars run on a
platform with documented public JSON (each also publishes ICS and RSS), so
nothing is scraped. JSON was picked over their ICS exports because it carries
what the feed needs and the ICS files drop: a stable id per occurrence,
coordinates, cost, tags and the audience.

1. An official Purdue Indianapolis events calendar exposing `.ics`, RSS, or
   JSON. An iCal feed is ideal because `src/scheduleSync.mjs` already parses
   that format and its parser is tested.
2. A documented public API from whatever platform hosts the events calendar.
3. HTML scraping. Last resort: brittle, and needs its own change detection.

The ingest reads every source below every 6 hours
(`db/supabase-campus-events-ingest.sql`), one page at a time with a second
between pages. Organizers add and edit events at any hour, so no source has a
publishing schedule of its own to follow.

### Purdue's events calendar (Localist), group "Purdue in Indianapolis": on

- URL: `https://events.purdue.edu/api/2/events?group_id=46197580344207&days=120&pp=100&distinct=true&page=<n>`.
  `group_id` 46197580344207 is the "Purdue in Indianapolis" group.
- Format: Localist API v2 JSON, `{ events: [{ event }], page: { current, total } }`,
  100 events a page. `distinct=true` lists each event once, with its next
  occurrence.
- Terms: no key. robots.txt allows `/api/` with `Crawl-Delay: 1`.
- Volume on 2026-10-17: 55 events in the next 120 days, 15 of them official
  "Dates and Deadlines" (breaks, the last day of classes) that every student
  can see without linking a feed.
- Ids: the event instance id (`event_instances[].event_instance.id`), one per
  occurrence; the event id groups a recurring series.
- Filter: the group also carries West Lafayette events (Mackey Arena) and
  Indianapolis events far from campus (the State Fairgrounds), so a listing is
  kept only when its place names the campus or its coordinates are within
  2.5 km. A listing with no place at all (a deadline, a virtual event) is kept
  on the group's word.

### IU's events calendar (LiveWhale), category "IU Indianapolis": on

- URL: `https://events.iu.edu/live/json/events/category/IU%20Indianapolis/near_location/39.774,-86.1765/near_distance/1/start_date/<YYYY-MM-DD>/end_date/<YYYY-MM-DD>/response_fields/location,tags,summary,group_title,event_types?page=<n>`,
  a 31-day window from today. `near_location` and `near_distance` keep events
  within 1 mile of the campus at 39.774, -86.1765.
- Format: LiveWhale JSON, `{ meta: { total_pages }, data: [...] }`, 100 events a
  page.
- Terms: no key. robots.txt allows everything.
- Volume on 2026-10-17: 1,330 IU Indianapolis events in all, 320 within a mile
  in the next 31 days. Student Affairs events are the core; Campus Recreation
  fitness classes, Herron exhibits and School of Medicine seminars fill the
  rest.
- Ids: the LiveWhale event id. A multi-day event (an exhibit) repeats its id
  once per day, and those rows merge into one row spanning the days listed.
- Owner decision still open: whether IU Indianapolis's own events are open to
  Purdue students. The rows carry `source_key = 'iu_events'`, and the read path
  labels them "IU event" until it is made.

### Anthology Engage event search on BoilerLink and TheSpot: off by default

- URLs: `https://boilerlink.purdue.edu/api/discovery/event/search?endsAfter=<ISO>&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=100&skip=<n>&query=`
  (BoilerLink, Purdue's Engage), and the same path on
  `thespot.indianapolis.iu.edu` (TheSpot, IU Indianapolis's Engage). The probes
  in #16 used `/api/discovery/event/search/events` and
  `/api/discovery/search/events`, which only answer the site's HTML shell.
- Format: Engage JSON, `{ "@odata.count", value: [...] }`, 100 events a page.
- Terms: no key, but both robots.txt files say `Disallow: /api/`; the event
  pages (`/event/<id>`) are allowed. The ingest reads them only with
  `CAMPUS_EVENTS_ENGAGE=on`, which defaults to off until the owner asks
  Purdue's Student Activities and Organizations (the BoilerLink admins), and
  TheSpot's admins, for an OK or for Engage API keys (#16's path c). The club
  directory (`src/boilerlinkClubs.mjs`) already reads BoilerLink's `/api/`
  organizations search every 6 hours, so this would be more of the same
  reading, but it is the owner's call.
- Volume on 2026-10-17: BoilerLink 1,282 upcoming events, 71 of them in
  Indianapolis (16 tagged Free Food by the organizer); TheSpot 574.
- Ids: the Engage event id.
- Filter: BoilerLink covers every Purdue campus, so an event is kept when its
  organization is an Indianapolis one (`isIndianapolisOrganization` in
  `src/boilerlinkClubs.mjs`, through the club directory), or its place names
  the campus, or its coordinates are within 2.5 km. TheSpot is IU
  Indianapolis's own instance, so every organization on it counts as an
  Indianapolis one.

Not chosen yet, each a later change: the city sources for #30 (the
Ticketmaster Discovery API needs a key; White River State Park publishes an
Events Calendar feed) and IU Indy Jaguars athletics (an ICS feed with a
30-second crawl delay).

## Schema sketch

```sql
CREATE TABLE IF NOT EXISTS campus_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Deliberately NO user_id. This table is campus-wide.
  title TEXT NOT NULL,
  description TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  location TEXT,
  all_day BOOLEAN NOT NULL DEFAULT FALSE,

  source_key TEXT NOT NULL,   -- which ingest produced this, e.g. 'purdue_indy_events'
  source_url TEXT,            -- link out to the canonical listing
  external_uid TEXT,          -- the feed's own id, when it provides one

  dedupe_key TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_campus_events_starts_at ON campus_events(starts_at);
```

Built as `db/supabase-campus-events.sql`, with seven columns this sketch did not
have: `category`, `free_food`, `venue_kind`, `open_to_all`, `series_key`,
`content_hash` and `classifier`. [campus-events-ingest.md](campus-events-ingest.md)
says what fills each one.

## Dedupe

Duplicates are the main risk, since the same event can appear in more than one
feed and the same feed is re-read on every ingest.

Make the database enforce it rather than writing dedupe logic. `dedupe_key` is
computed once at ingest and carries a `UNIQUE` constraint, so every write is an
idempotent upsert:

```
dedupe_key = sha256(lower(trim(title)) || '|' || starts_at || '|' || lower(trim(coalesce(location, ''))))
```

Prefer the feed's own `external_uid` when it supplies a stable one, falling back
to the hash. Writing then becomes:

```
upsert(rows, { onConflict: 'dedupe_key' })   -- also refreshes last_seen_at
```

Two deliberate choices:

- **Do not include `description` in the key.** Organisers edit blurbs; a
  description change would otherwise mint a second row for the same event.
- **Do not include `ends_at`.** Some feeds omit it, and an added end time should
  update the existing row rather than fork it.

Known limit: an event whose start time is corrected by an hour produces a new
row and orphans the old one. Sweep by `last_seen_at` the way
`calendarItemStore` sweeps per-source rows, so anything a feed stops listing
ages out instead of lingering forever.

As built: every source above supplies an id, so `dedupe_key` is
`<source_key>:<id>` and the hash is the fallback for a row without one. Ids
differ between sources, so the key alone cannot catch the same event
cross-posted on two of them (Purdue Indy Badminton's weekly hours are on both
BoilerLink and TheSpot). Each ingest run therefore also collapses rows from
different sources that share a normalized title and start minute, keeping the
source listed first above. The sweep runs per source, after a complete fetch:
rows of that source the run did not write are deleted.

## Read path

Do not copy shared events into `calendar_items`. That would recreate exactly the
per-user duplication this design removes, and would put the rows under a
`source_id` that the sync sweep will then delete.

Union at the API seam instead. `/api/me/calendar` and `/api/me/events` already
funnel through `listCalendarItems` (`src/calendarReads.mjs`), which is the natural
place to merge a second, unscoped query and sort the combined set by start time.
Shared rows need a marker in the response (`shared: true`, or
`source_type: 'campus'`) so clients can style them, and so "mark done" is not
offered on an event the user does not own.

As built ([campus-events-feed.md](campus-events-feed.md)): `listCalendarItems`
merges the shared rows only into a read that asks for them, `GET
/api/me/calendar?shared=1` (the Events and Free Food window) and `GET
/api/me/events`, and only while `CAMPUS_EVENTS_FEED` is on. The unfiltered
reads behind Assignments and the native app's task list never ask, so a shared
row cannot reach a list that offers "mark done". The rows carry both markers,
`shared: true` and `sourceType: 'campus'`, plus a source label and the
listing's link. A missing table, or any failed read of it, leaves the
student's own rows alone. West Lafayette and other-city rows and members-only
sessions are left out, a series is listed once as its next occurrence, and a
row the ingest has not written for 26 hours counts as gone.

Interaction with the existing regex: once shared events exist, the
`campus_event` branch in `src/scheduleSync.mjs:42` is redundant at best and a
competing source at worst. Decide explicitly whether to keep classifying private
rows as `campus_event` or to retire that branch. Retiring it is probably right,
but it changes what existing users see and should be its own change.

## Rollout

1. Confirm the public source and record it above. Done 2026-10-17.
2. Add `db/supabase-campus-events.sql` and apply it in the SQL Editor. Added;
   applying it is the owner's step (README step 43).
3. Write the ingest as a scheduled job with a dry-run mode that reports what it
   would upsert. Run it read-only first and inspect the dedupe results. Built;
   the dry run and the cron are the owner's steps (README step 44).
4. Union into the read path behind a flag. Built, behind `CAMPUS_EVENTS_FEED`;
   turning it on is the owner's step, after steps 2 and 3 have run
   ([campus-events-feed.md](campus-events-feed.md)).
5. Decide the fate of the `campus_event` regex.

Steps 1 through 3 are independently reviewable and ship nothing user visible, so
the risky part (the read path) lands last.
