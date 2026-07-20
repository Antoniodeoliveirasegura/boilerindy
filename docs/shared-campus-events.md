# Shared campus events (design)

Status: proposed, not implemented. No migration exists yet.

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

## Open question: which public feed

**This must be verified before any code is written.** The repo has no public
events source today. `src/purdueCalendarAutomation.mjs` drives the *personal*
timetable export at `timetable.mypurdue.purdue.edu`, which sits behind login and
Duo and is therefore not a candidate.

To confirm, in order of preference:

1. An official Purdue Indianapolis events calendar exposing `.ics`, RSS, or
   JSON. An iCal feed is ideal because `src/scheduleSync.mjs` already parses
   that format and its parser is tested.
2. A documented public API from whatever platform hosts the events calendar.
3. HTML scraping. Last resort: brittle, and needs its own change detection.

Record the chosen URL, its format, its terms of use, and its update cadence in
this document before implementing. Do not hardcode a guessed URL.

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

## Read path

Do not copy shared events into `calendar_items`. That would recreate exactly the
per-user duplication this design removes, and would put the rows under a
`source_id` that the sync sweep will then delete.

Union at the API seam instead. `/api/me/calendar` and `/api/me/events` already
funnel through `listCalendarItems` (`server.mjs:808`), which is the natural
place to merge a second, unscoped query and sort the combined set by start time.
Shared rows need a marker in the response (`shared: true`, or
`source_type: 'campus'`) so clients can style them, and so "mark done" is not
offered on an event the user does not own.

Interaction with the existing regex: once shared events exist, the
`campus_event` branch in `src/scheduleSync.mjs:42` is redundant at best and a
competing source at worst. Decide explicitly whether to keep classifying private
rows as `campus_event` or to retire that branch. Retiring it is probably right,
but it changes what existing users see and should be its own change.

## Rollout

1. Confirm the public source and record it above.
2. Add `db/supabase-campus-events.sql` and apply it in the SQL Editor.
3. Write the ingest as a scheduled job with a dry-run mode that reports what it
   would upsert. Run it read-only first and inspect the dedupe results.
4. Union into the read path behind a flag.
5. Decide the fate of the `campus_event` regex.

Steps 1 through 3 are independently reviewable and ship nothing user visible, so
the risky part (the read path) lands last.
