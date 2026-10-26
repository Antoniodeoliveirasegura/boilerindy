# Shared campus events (design)

Status: rollout steps 1 to 4 are built. The sources are chosen (below), the
table is `db/supabase-campus-events.sql`, and the ingest, with its dry run, is
`POST /api/internal/campus-events/ingest` ([campus-events-ingest.md](campus-events-ingest.md)).
The read path (step 4) lists the table on `/events` and `/free-food` behind
`CAMPUS_EVENTS_FEED`, off by default ([campus-events-feed.md](campus-events-feed.md)).
The first source beyond campus, White River State Park's events calendar
(below), is built behind `CAMPUS_EVENTS_DOWNTOWN`, also off by default, with
README step 49 ([campus-events-ingest.md](campus-events-ingest.md#downtown-events)).

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

- URL: `https://events.iu.edu/live/json/events/category/IU%20Indianapolis/start_date/<YYYY-MM-DD>/end_date/<YYYY-MM-DD>/response_fields/location,tags,summary,group_title,event_types?page=<n>`,
  a 31-day window from today, with no distance filter. Until 2026-10-26 the
  path also carried `near_location/39.774,-86.1765/near_distance/1`, which
  LiveWhale applies to coordinates alone: it dropped every listing without any
  (304 of the 647 that day, every athletics listing among them) along with the
  32 placed more than a mile out, most of them the medical school's. The
  Indianapolis rules place each listing instead, and `LIVEWHALE_EXCLUDED_GROUPS`
  leaves out the groups that are not for students
  ([campus-events-ingest.md](campus-events-ingest.md)).
- Format: LiveWhale JSON, `{ meta: { total_pages }, data: [...] }`, 100 events a
  page.
- Terms: no key. robots.txt allows everything.
- Volume on 2026-10-26: 647 listings in the next 31 days, 343 of them with
  coordinates, which the plan turns into 234 rows (the distance filter left
  182). Student Affairs events are the core (110 rows); the schools, Bepko's
  study sessions, International Affairs and Student Employment fill the rest.
  On 2026-10-17 the category held 1,330 events in all.
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
  pages (`/event/<id>`) are allowed. Purdue's Student Activities and
  Organizations (the BoilerLink admins) agreed on 2026-10-18 to BoilerIndy
  reading BoilerLink's public event search every 6 hours, in reply to the
  owner's email, which also mentioned that the club directory
  (`src/boilerlinkClubs.mjs`) reads the organizations search on the same
  `/api/` path. The ingest reads each site only when `CAMPUS_EVENTS_ENGAGE`
  names it: production runs `boilerlink`; TheSpot's admins have not been
  asked.
- Volume on 2026-10-17: BoilerLink 1,282 upcoming events, 71 of them in
  Indianapolis (16 tagged Free Food by the organizer); TheSpot 574.
- Ids: the Engage event id.
- Filter: BoilerLink covers every Purdue campus, so an event is kept when its
  organization is an Indianapolis one (`isIndianapolisOrganization` in
  `src/boilerlinkClubs.mjs`, through the club directory), or its place names
  the campus, or its coordinates are within 2.5 km. TheSpot is IU
  Indianapolis's own instance, so every organization on it counts as an
  Indianapolis one.

### White River State Park's events calendar (The Events Calendar): off by default

The first downtown source (issue #30): the park's museums, zoo and lawns are a
walk from campus, but they are not the campus, so its rows say so (venue
`downtown`, label "Downtown") and the source is read only with
`CAMPUS_EVENTS_DOWNTOWN` on.

- URL: `https://whiteriverstatepark.org/wp-json/tribe/events/v1/events`, The
  Events Calendar's REST list, with no query string at all.
- robots.txt, checked 2026-10-24: every user agent gets `Disallow: /*?` (any
  URL with a query string) and `Crawl-delay: 3`; `/wp-json/` is allowed. So
  the ingest does not send `start_date`, `end_date`, `per_page` or `page`.
  Without them the site answers its defaults, which its `rest_url` echoes:
  `page=1`, `per_page=50`, from yesterday to two years out, published only.
  That is one request a run, so the crawl delay never comes up, and the
  ingest keeps its own window from it: not over before today on the campus
  calendar, starting within 60 days (`inTribeWindow` in
  `src/campusEventsIngest.mjs`). Should the list outgrow 50 listings, the run
  reads the first page, reports the source incomplete and does not sweep it,
  since a second page needs `?page=`.
- Terms, checked 2026-10-24: no key, and no terms of use. The site's page
  sitemap lists none, and its footer links only a privacy policy, which is
  WordPress's default text (comments, cookies, embedded content) and says
  nothing about automated access or reuse.
- Format: `{ events: [...], rest_url, total, total_pages }`.
- Volume on 2026-10-24 (17:30 in Indianapolis): 27 listings in all, through
  August 2027, and 19 between that day and December 23, at the Indiana State
  Museum and its IMAX, the Indianapolis Zoo, the Eiteljorg, the NCAA Hall of
  Champions, Military Park and the Canal Walk. (A query string asking for 60
  days had answered 17 on 2026-10-23.)
- Time zone: the site sets the calendar's zone to "UTC+0". Every listing says
  `timezone: "UTC+0"` and repeats its `start_date` as `utc_start_date` (Día de
  Muertos at the Eiteljorg reads 10:00 in both), so the times are the
  Indianapolis wall clock. The adapter reads `start_date` and `end_date` in
  `America/Indiana/Indianapolis`, on either side of a daylight saving change,
  and ignores the "UTC" fields (`campusWallClockToIso`, pinned by a fixture
  test).
- Ids: the listing's WordPress post id, one per occurrence. A series is one
  title at one venue (the two Twilight Tales nights at the Indiana State
  Museum).
- Filter: the park's own calendar (`indianapolisScope`), so a listing with
  Indianapolis in its venue's address is kept as `place`, one with nothing to
  place it (the Canal Walk) as `scope`, and one naming another city drops as
  `away`. Every listing kept is `venue_kind` `downtown`, unless it is online.
- Free food: never from free entry, the park's "Free Event" category or a
  cost of "Free", with or without food in the listing. On 2026-10-24 the
  Localist rule (free entry together with food in the text) would have marked
  three: the Book Fair ("Sweet treats" from its vendors, drinks for purchase),
  the MLK Day free admission (it collects for Gleaners Food Bank) and Trail &
  Treat (treats for children along the canal). Only the keyword matcher, or
  Jev with `CAMPUS_EVENTS_CLASSIFY` on, counts: none of the 19 had free food.

Not chosen yet, each a later change: the other city sources for #30 (the
Ticketmaster Discovery API needs a key, set aside by the owner's call of
2026-10-18; the Indianapolis Public Library's iCal feed waits on a permission
email; Visit Indy and Do317 ban scraping in their terms and need a feed
agreement) and IU Indy Jaguars athletics (an ICS feed with a 30-second crawl
delay).

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
reads behind the Tasks page and the native app's task list never ask, so a
shared row cannot reach a list that offers "mark done". The rows carry both
markers, `shared: true` and `sourceType: 'campus'`, plus a source label and the
listing's link. A missing table, or any failed read of it, leaves the
student's own rows alone. West Lafayette and other-city rows and members-only
sessions are left out, downtown rows are listed (labeled "Downtown") only while
`CAMPUS_EVENTS_DOWNTOWN` is on, a series is listed once as its next
occurrence, and a row the ingest has not written for 26 hours counts as gone. Signed out,
`/free-food` reads the rows with free food alone through
`GET /api/campus-events/free-food` (issue #366), which never sees a session
and so never a student's rows.

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
