# Shared campus events ingest

Issue #30. The cron route that reads Purdue's and IU's public events calendars
into the shared `campus_events` table every 6 hours, with a dry run that writes
nothing. `/events` and `/free-food` list the table behind `CAMPUS_EVENTS_FEED`,
off by default: [campus-events-feed.md](campus-events-feed.md) is that read
path. The sources, and why they were chosen, are in
[shared-campus-events.md](shared-campus-events.md).

## How a run works

`POST /api/internal/campus-events/ingest` (`src/routes/campusEvents.mjs`),
bearer-authenticated with `PUSH_CRON_SECRET`, the same token as the reminder
runner and the calendar re-sync. With the secret unset the route does not
exist.

1. **Fetch** (`src/campusEventsIngest.mjs`). Every enabled source, one after the
   other, a page at a time with a second between pages (Purdue's robots.txt
   asks for that delay; every source gets it). A page that fails transiently is
   retried once after 1.5 s. A source that still fails, or answers something
   that is not its JSON, is reported in the summary and the run goes on with
   the others.
   - Purdue's events calendar (Localist): `purdue_events`, always on.
   - IU's events calendar (LiveWhale): `iu_events`, always on.
   - BoilerLink and TheSpot (Anthology Engage): `boilerlink` and `thespot`, each
     only when `CAMPUS_EVENTS_ENGAGE` names it (`boilerlink`, `thespot`, a comma
     list, or `on` for both). Both sites' robots.txt disallow `/api/`. Purdue's
     Student Activities and Organizations agreed on 2026-10-18 to BoilerIndy
     reading BoilerLink's public event search every 6 hours (about 15 requests
     a run, public events only, each linked back to its BoilerLink page), so
     production runs `CAMPUS_EVENTS_ENGAGE=boilerlink`. TheSpot's admins have
     not been asked.
2. **Plan** (`src/sharedEvents.mjs`, pure). Each listing becomes a row, the
   Indianapolis filter keeps or drops it, one source's repeated ids merge, and
   the same event listed by two sources collapses into one row.
3. **Write**, unless it is a dry run. Every row is upserted on `dedupe_key` with
   `last_seen_at` set to the run's start, 500 to a request. Then, for each
   source fetched completely and with listings in it, the rows of that source
   whose `last_seen_at` is older are deleted: events the feed no longer lists,
   and rows the filter or the dedupe now drop. A source that failed, or answered
   nothing, is not swept, so an outage cannot empty it. A failed sweep is
   logged and left to the next run.

One run at a time: a second call while one is running answers 409.

## What a row says

The columns are in `db/supabase-campus-events.sql`. Everything below is a rule
over the source's own data; a classifier can refine it later (see
[The Jev hook](#the-jev-hook)).

| Column | Rule |
|---|---|
| `dedupe_key` | `<source_key>:<id>`: Localist's event instance id (one per occurrence), LiveWhale's event id, the Engage event id. Without an id, the design doc's sha256 of the trimmed, lowercased title, the start and the trimmed, lowercased location. |
| `series_key` | `<source_key>:` and a hash of the organizer or group (the Localist event, the LiveWhale group, the Engage organization) and the folded title, so a weekly practice is one series. |
| `content_hash` | sha256 of the title, description and location: the text a classifier reads. |
| `free_food` | The source's own tag (LiveWhale's "Free food", Engage's "Free Food" benefit); or free entry (Localist's `free`, a LiveWhale cost that starts with "Free") together with food in the listing; or the keyword matcher in `src/freeFood.mjs`. Free entry alone is not free food: Purdue's hockey games carry `free`. |
| `category` | From the source's types (Localist event types, LiveWhale event types and fitness tags, the Engage theme), with the keys of the planned Jev category question plus `deadline` for Purdue's "Dates and Deadlines". NULL when the source gives nothing usable. |
| `venue_kind` | `online` (Localist's `virtual`, LiveWhale's online only, "Online" or "Zoom" as the location, "online only" in the title), `indy_campus` (a campus building or room in the title or location, or within 2.5 km of campus), `west_lafayette` (a West Lafayette place in the location, or coordinates near that campus), `elsewhere` (another city in the location, or coordinates farther out), else `unknown`. |
| `open_to_all` | `false` for a practice, rehearsal, officer or committee meeting, tryout or members-only session (by title); `true` when the source lists students or the public as the audience; NULL otherwise. |
| `classifier` | Never written by this ingest. |

The Indianapolis filter decides in this order, and the summary counts each
reason:

1. `place`: a campus building, room code with a number ("ET 103", "IO 102") or
   landmark (Campus Center, The Jungle, Boiler Park), or Indianapolis itself,
   in the title or location. Kept.
2. `near`: coordinates within 2.5 km of the campus at 39.774, -86.1765. Kept.
3. `away`: West Lafayette or another city named in the location. Dropped, even
   for an Indianapolis organizer.
4. `org` (Engage only): an Indianapolis organization. On BoilerLink that is
   the club directory's flag (`isIndianapolisOrganization`, which also reads the
   organization's description), or the name alone when the directory does not
   list it; on TheSpot, IU Indianapolis's own instance, every organization.
   Kept, so an Indianapolis club's away game is kept too, with `venue_kind`
   `elsewhere`.
5. `scope`: the source's own query is about Indianapolis (Purdue's "Purdue in
   Indianapolis" group, IU's "IU Indianapolis" category within a mile) and the
   listing has no coordinates to check: a deadline, a virtual event, a room
   named only by its building. Kept.
6. Otherwise dropped: `far` when the coordinates are more than 2.5 km out (the
   State Fairgrounds, Mackey Arena), `unplaced` when nothing places it.

Far-away coordinates never outvote an organizer: Engage coordinates are often
wrong (TheSpot puts University Hall in Texas).

One more drop applies after those rules, to a LiveWhale listing they would
keep: `group`, when its `group_title` is one of `LIVEWHALE_EXCLUDED_GROUPS` in
`src/sharedEvents.mjs` (compared folded). Today those are three groups whose
listings are not for Purdue students, 66 of the 320 IU listings on 2026-10-18:

- the IU School of Medicine Calendar (50): room bookings, exam sittings, grand
  rounds and research seminars;
- IU Indianapolis Faculty Crossing Events (13): development sessions for
  faculty;
- Kelley School of Business Executive Education Programs Events (3): paid
  programs for working professionals.

A listing the place rules already drop keeps its own reason (`away`, `far`).
Rows a run no longer plans are swept, so the first run after a change removes
the stored rows of a newly excluded group.

## The dry run

`?dryRun=1` (or `true`), or a JSON body `{ "dryRun": true }`, runs the fetch
and the plan and answers every row a run would write, with no database call
at all, so it works before the migration has run:

```bash
curl -sS -X POST -H "Authorization: Bearer $PUSH_CRON_SECRET" \
  'https://boilerindy-api.onrender.com/api/internal/campus-events/ingest?dryRun=1' > dry-run.json
```

Read `sources` (what each signal kept and dropped), `dropped` (up to 50 dropped
listings with the reason), `collapsed` (cross-source duplicates) and `rows`.
The live dry run of 2026-10-17, Engage off, answered in 14 s:

```json
{ "ok": true, "dryRun": true, "startedAt": "2026-10-17T13:37:46.235Z",
  "sources": [
    { "key": "purdue_events", "enabled": true, "ok": true, "complete": true, "pages": 1, "error": null,
      "listings": 55, "skipped": 0, "keptBy": { "place": 18, "scope": 20, "near": 3 }, "droppedBy": { "far": 10, "away": 4 },
      "merged": 0, "rows": 41 },
    { "key": "iu_events", "enabled": true, "ok": true, "complete": true, "pages": 4, "error": null,
      "listings": 320, "skipped": 0, "keptBy": { "place": 269, "near": 51 }, "droppedBy": {},
      "merged": 62, "rows": 258 },
    { "key": "boilerlink", "enabled": false },
    { "key": "thespot", "enabled": false }
  ],
  "collapsed": [],
  "dropped": [{ "source_key": "purdue_events", "title": "Winter Commencement", "starts_at": "2026-12-20T05:00:00.000Z",
    "location": "Guy J. Mackey Arena", "why": "away" }, "..."],
  "totals": { "rows": 299, "freeFood": 9,
    "venueKinds": { "indy_campus": 273, "online": 11, "unknown": 15 },
    "categories": { "sports_fitness": 107, "academic": 74, "none": 55, "career": 17, "social": 14,
      "arts_culture": 12, "deadline": 11, "wellness": 9 } },
  "rows": ["..."],
  "durationMs": 14372 }
```

The 14 Purdue listings dropped were the State Fairgrounds hockey games and the
World Food Championships, the Carmel Christmas show, a West Lafayette workshop
and the four Winter Commencement listings at Mackey Arena. The 62 IU merges are
multi-day exhibits listed once a day. A real run answers the same summary
without `rows`, plus `upserted` and, per swept source, `swept`.

## Turning it on (owner)

1. Run `db/supabase-campus-events.sql` in the Supabase SQL Editor (README step
   43). Until then a real run answers 503 `campus_events_schema_missing`.
2. Run the dry run above and read it.
3. Schedule the cron with the snippet in `db/supabase-campus-events-ingest.sql`
   (README step 44): every 6 hours at minute 41. It needs the `pg_cron` and
   `pg_net` extensions from `db/supabase-keep-warm.sql`.
4. Set `CAMPUS_EVENTS_ENGAGE=boilerlink` (Purdue agreed on 2026-10-18), and
   add `thespot` only once TheSpot's admins have said yes. Turning a source off
   later leaves its rows in place, since a source that is not fetched is not
   swept: delete them with
   `delete from campus_events where source_key in ('boilerlink', 'thespot');`
   (or just the one key).
   (The read path stops listing them 26 hours after their last run anyway.)
5. Then turn on the read path, `CAMPUS_EVENTS_FEED`:
   [campus-events-feed.md](campus-events-feed.md#turning-it-on-owner).

## Answers

| Status | When |
|---|---|
| 200 | The summary above. A source that failed is in it with `ok: false` and its `error`. |
| 401 | `Invalid cron secret.` |
| 404 | `PUSH_CRON_SECRET` is unset: the route does not exist. |
| 409 | A run is already in flight. |
| 503 | `campus_events_schema_missing`: the migration has not run (a dry run still works). Otherwise a database 5xx or timeout that survived its retry, logged as a warning; the next run retries. |
| 500 | Any other database failure, logged as an error. |

## The Jev hook

Jev (TypeSafe's decision model, issue #121) is not wired: there is no key yet.
Three things are in place for it:

- `content_hash` marks the text it would read, and a trigger in
  `db/supabase-campus-events.sql` clears `classifier` when an update changes
  `content_hash` without bringing a verdict of its own. `classifier IS NULL` is
  therefore the queue of rows to ask about, and an edited listing is asked
  again.
- `runCampusEventsIngest` takes a `classify` option: an async function given
  the planned rows that resolves with them, where it may have refined
  `category`, `free_food`, `venue_kind` and `open_to_all` and added
  `classifier` (the model id, the answers and probabilities, `classified_at`).
  Rows with and without `classifier` are upserted in separate batches, so a row
  that has none never erases a stored verdict. Nothing passes it yet.
- `category` and `venue_kind` use the keys of the planned Jev questions, so a
  verdict drops straight into the columns their CHECK constraints allow.

The design rules for that change: classify at ingest, never at read; combine
with the rules rather than replace them (`free_food` stays true when the source
tags it); and pin a versioned model id once the thresholds are tuned.

## Known limits

- Free food a listing offers without the matcher's words or a free flag ("enjoy
  some free Caribou Coffee") is missed until a classifier reads the text.
- An Indianapolis club's away game is kept (`venue_kind` `elsewhere`), and an
  event whose start moves by an hour on a source without stable ids becomes a
  new row (the old one is swept on the next complete run).
- A multi-day LiveWhale event (an exhibit running for weeks) is one row
  spanning only the days inside the 31-day window, so its start moves forward
  with each run and its end is the window's. Localist's `distinct=true` gives
  the same "next occurrence" view of a recurring event.
- Whether IU Indianapolis's own events are open to Purdue students is an owner
  decision; the rows carry `source_key = 'iu_events'`, and the read path labels
  them "IU event" until it is made.
- Each source is ingested in full every run. At today's volumes that is 5 page
  requests with Engage off and about 24 with it on.

## Tuning

Constants at the top of `src/campusEventsIngest.mjs` (`PAGE_DELAY_MS`,
`PAGE_TIMEOUT_MS`, `MAX_PAGES`, `UPSERT_BATCH_SIZE`) and the source table in
`src/sharedEvents.mjs` (`SOURCES`: the Localist window of 120 days, the LiveWhale
window of 31 days and distance of 1 mile). `complete: false` with "more than N
pages" means a source outgrew its page cap. The cron's `pg_net` timeout is 180
seconds. A run with Engage off took 14 s on 2026-10-17; with it on a run reads
about 24 pages a second apart, so it should still finish well inside that.
