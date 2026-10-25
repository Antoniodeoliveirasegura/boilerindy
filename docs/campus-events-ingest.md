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
3. **Classify**, only with `CAMPUS_EVENTS_CLASSIFY` on (or `shadow`) and never
   in a dry run: Jev answers four questions about each new or edited listing
   and refines the rows ([Jev classification](#jev-classification)).
4. **Write**, unless it is a dry run. Every row is upserted on `dedupe_key` with
   `last_seen_at` set to the run's start, 500 to a request. Then, for each
   source fetched completely and with listings in it, the rows of that source
   whose `last_seen_at` is older are deleted: events the feed no longer lists,
   and rows the filter or the dedupe now drop. A source that failed, or answered
   nothing, is not swept, so an outage cannot empty it. A failed sweep is
   logged and left to the next run.

One run at a time: a second call while one is running answers 409.

## What a row says

The columns are in `db/supabase-campus-events.sql`. Everything below is a rule
over the source's own data; with `CAMPUS_EVENTS_CLASSIFY` on, Jev refines four
of them (see [Jev classification](#jev-classification)).

| Column | Rule |
|---|---|
| `dedupe_key` | `<source_key>:<id>`: Localist's event instance id (one per occurrence), LiveWhale's event id, the Engage event id. Without an id, the design doc's sha256 of the trimmed, lowercased title, the start and the trimmed, lowercased location. |
| `series_key` | `<source_key>:` and a hash of the organizer or group (the Localist event, the LiveWhale group, the Engage organization) and the folded title, so a weekly practice is one series. |
| `content_hash` | sha256 of the title, description and location: the text Jev reads. A stored verdict is reused while it is unchanged. |
| `free_food` | The source's own word: its tag (LiveWhale's "Free food", Engage's "Free Food" benefit), a LiveWhale cost that names free food, or free entry (Localist's `free`, a LiveWhale cost that starts with "Free") together with food in the listing or its tags. Else the keyword matcher in `src/freeFood.mjs`, which Jev's answer replaces when it has one. Free entry alone is not free food: Purdue's hockey games carry `free`. |
| `category` | From the source's types (Localist event types, LiveWhale event types and fitness tags, the Engage theme), with the keys of Jev's category question plus `deadline` for Purdue's "Dates and Deadlines". NULL when the source gives nothing usable. Jev may fill or replace it, never a deadline. |
| `venue_kind` | `online` (Localist's `virtual`, LiveWhale's online only, "Online" or "Zoom" as the location, "online only" in the title), `indy_campus` (a campus building or room in the title or location, or within 2.5 km of campus), `west_lafayette` (a West Lafayette place in the location, or coordinates near that campus), `elsewhere` (another city in the location, or coordinates farther out), else `unknown`. Jev may turn `unknown` into `online` or `elsewhere`. |
| `open_to_all` | `false` for a practice, rehearsal, officer or committee meeting, tryout or members-only session (by title); `true` when the source lists students or the public as the audience; NULL otherwise. Jev may close one (a staff luncheon) or open one. |
| `classifier` | Jev's stored verdict: the model, the question version, every answer with its probabilities, and `classified_at`. Written only with `CAMPUS_EVENTS_CLASSIFY` on or `shadow`; NULL otherwise, and again after the text changes. |
| `organization_key` | README step 48 (`db/supabase-club-follows.sql`, issue #16): the Engage organization that listed the event, `boilerlink:<organizationId>` or `thespot:<organizationId>`, which following a club reads ([clubs.md](clubs.md#following-a-club)). NULL for Localist and LiveWhale, and for an Engage listing whose `organizationId` is not a positive integer. A row that absorbs another source's copy of the event takes the copy's key when it has none. Written on every row of every run, so the first run after step 48 fills the stored rows. |

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
without `rows`, plus `upserted`, `organizationKeys` and, per swept source,
`swept`, and with classification on, `classify` ([Jev
classification](#jev-classification)). A dry run never asks Jev: its rows are
the rules' answers, and with classification on it says
`"classify": { "skipped": "dry run" }`.

`organizationKeys` is `"written"`, or `"column_missing"` before README step 48
has added `campus_events.organization_key`: the first batch that names the
column fails on it, the log says once
`[club_follows] schema missing: run db/supabase-club-follows.sql in the
Supabase SQL Editor, then retry.`, and that batch and every later one go up
without it. The run otherwise writes and sweeps as before.

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
6. Optionally, Jev: [Jev classification](#turning-jev-on-owner).

## Answers

| Status | When |
|---|---|
| 200 | The summary above. A source that failed is in it with `ok: false` and its `error`. |
| 401 | `Invalid cron secret.` |
| 404 | `PUSH_CRON_SECRET` is unset: the route does not exist. |
| 409 | A run is already in flight. |
| 503 | `campus_events_schema_missing`: the migration has not run (a dry run still works). Otherwise a database 5xx or timeout that survived its retry, logged as a warning; the next run retries. |
| 500 | Any other database failure, logged as an error. |

## Jev classification

Off by default. With `CAMPUS_EVENTS_CLASSIFY=on` and `TYPESAFE_API_KEY` set,
each real run asks Jev, TypeSafe's decision model (`src/campusEventsClassify.mjs`
over `src/jevClient.mjs`), four questions about every listing it holds no
current verdict for, and combines the answers with the rules above. `shadow`
asks and stores the same verdicts but changes no column, so they can be read
before they count. With the switch on and no key, the server says so once at
boot and the ingest keeps to its rules. Classify at ingest, never at read: the
Events and Free Food reads only see the stored columns.

### What Jev reads and answers

The state is the listing's own public text as named fields: `title`,
`location`, `starts` (campus time) and `description` (cut at 1,500
characters). Nothing about any student is sent, and the Privacy page names
TypeSafe for this. The questions are `EVENT_QUESTIONS`:

| Key | Type | Asks |
|---|---|---|
| `category` | choice | The main kind of event, with the `category` keys except `deadline`. |
| `free_food` | noul | Attendees are offered food or drinks at no cost. |
| `where` | choice | Where it takes place, with the `venue_kind` keys. |
| `open_to_all` | noul | A student who is not a member of the organizing group could show up. |

The model is pinned (`JEV_MODEL`, `jev-1.13.0`), never an alias: `jev-latest`
moves when TypeSafe ships, and the thresholds were tuned on this version.

### How the answers combine with the rules

| Column | With a verdict (`THRESHOLDS`) |
|---|---|
| `free_food` | The source's own word stays true. Otherwise Jev's `free_food` at 0.7 or above: Jev stands in for the keyword matcher, which reads the same text. |
| `open_to_all` | A rule's `false` (a practice, a rehearsal) stays. Jev under 0.2 makes it `false`, at 0.8 or above `true`; in between the rule's answer stands. A deadline is left alone. |
| `category` | A deadline stays. An empty one takes Jev's pick at a probability of 0.7 or more; the source's is replaced at 0.9 or more. |
| `venue_kind` | Only an `unknown` one, and only to `online` or `elsewhere` at 0.9 or more. Jev never says `indy_campus` here. |

The thresholds come from the evals of 2026-10-18: Jev on the 305 rows a run
plans with BoilerLink on (Purdue 40, IU 194, BoilerLink 71) against the rules,
and on 170 BoilerLink listings against their organizers' tags.

- Free food at 0.7 added the free food the rules missed ("enjoy some free
  Caribou Coffee", "coffee and cookies", "grab some coffee") and took none
  away: every free food row that day rested on the source's own word, which
  Jev cannot see (a "Free food" tag, a "Brunch" tag on a free event). Between
  0.5 and 0.7 sat a brown bag talk, a chili cook-off and a staff luncheon.
- Under 0.2 on `open_to_all` were only an instructors' monthly meeting, a staff
  luncheon and a faculty and staff lunch, which are now not listed. Practices
  and rehearsals scored 0.19 to 0.33; the title rule already has them.
- The category replacements at 0.9 were all right or defensible: ten "1:1
  Workshops: Mental Well-being" from academic to wellness, a "Campus Cleanup"
  from wellness to service. Fills under 0.7 changed when the order of the
  options was reversed.
- `where` put 60 of 100 West Lafayette events on this campus and the downtown
  Westin `elsewhere` at 0.86, so it only ever fills an `unknown` venue.
- Two identical runs over the 234 Purdue and IU rows moved the free food
  probabilities by 0.003 on average and flipped no decision; reversing the
  options flipped one free food answer that sat on the line (0.68 against 0.70).

Of those 305 rows, turning it on changes: free food on 3 more (Honors House
Coffee, an office hours with coffee and cookies, Coffee & Careers); 3 rows
closed, so no longer listed (the three above); `open_to_all` from NULL to
`true` on 27; 50 categories; no venue.

### Which rows are asked

A row whose stored `classifier` answers the same `content_hash`, under today's
`JEV_MODEL` and questions (`classifier.questions` is a hash of them), reuses it:
its columns are refined again from the stored answers, so changing a threshold
asks nothing. Every other row is asked: a new listing, an edited one (the
trigger in `db/supabase-campus-events.sql` clears a verdict when the text
changes without a new one), or one answered by another model or other
questions. Rows go soonest first, 4 at a time, at most 400 a run
(`CLASSIFY_MAX_ROWS`) and for at most 90 s (`CLASSIFY_BUDGET_MS`); what is left
is asked on the next run. On 2026-10-18 a call took about 0.2 s, so a first run
over 305 rows asks for about 15 s.

A call that fails after its retries (429, 529, a 5xx, a timeout: three retries
with backoff) leaves its row to the rules, without a verdict, until the next
run. A bad key or a malformed question (401, 422) stops the asking at once, as
do five failures in a row; the run goes on and writes the rules' rows, and the
server logs why. Only a failed read of the stored verdicts fails the run, as a
failed write would. Rows with and without a verdict are upserted in separate
batches, so a row asked in vain never erases a stored verdict.

A real run's answer carries `classify`: `mode`, `model`, `rows`, `reused`,
`asked`, `answered`, `failed`, `deferred` (left for the next run), `stopped`
(`row cap`, `time budget`, `Jev error: ...`, `5 failed calls in a row`, or
null), `inputTokens`, `changed` (rows per column the verdicts changed, or in
shadow would change), `examples` (up to 20 of those changes) and `durationMs`.
The server log line ends with `jev on: N reused, N asked, N failed, N left for
the next run`.

### Turning Jev on (owner)

1. Create a key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys)
   and set `TYPESAFE_API_KEY` on Render.
2. Set `CAMPUS_EVENTS_CLASSIFY=shadow` and redeploy. The next run (or one
   started with the curl above, without `?dryRun=1`) asks about every row and
   stores the verdicts without changing a column; its `classify.changed` and
   `examples` say what `on` would change.
3. Read the stored verdicts, then set `CAMPUS_EVENTS_CLASSIFY=on` and redeploy.
   The next run applies them without asking again.

```sql
select title, free_food, open_to_all, category, venue_kind,
       classifier->'answers'->'free_food'->>'p' as free_food_p,
       classifier->'answers'->'open_to_all'->>'p' as open_p,
       classifier->'answers'->'category'->>'choice' as jev_category
from campus_events
where classifier is not null
order by (classifier->'answers'->'free_food'->>'p')::numeric desc
limit 50;
```

Back to `off`, the next run writes the rules' answers; the stored verdicts
stay, and turning it on again reuses them.

Cost: about 1,240 input tokens a row at $0.042 per million, so a full pass over
305 rows is about $0.016, and later runs ask only about new and edited
listings, well under a dollar a month.

### Changing the model or the questions

Re-run an eval like the one of 2026-10-18 first (issue #30 has the method and
the numbers), then change `JEV_MODEL`, `EVENT_QUESTIONS` and `THRESHOLDS`
together in one change. A verdict records the model and a hash of the
questions, so the next runs ask again about every row, 400 a run, and verdicts
of two versions are never mixed.

## Known limits

- Without Jev, free food a listing offers without the matcher's words or a
  free flag ("enjoy some free Caribou Coffee") is missed. With it on, Jev
  reads the text, but not a source's tags: a tag it cannot see still counts
  through the source's own word.
- An Indianapolis club's away game is kept (`venue_kind` `elsewhere`), and an
  event whose start moves by an hour on a source without stable ids becomes a
  new row (the old one is swept on the next complete run).
- A multi-day LiveWhale event (an exhibit running for weeks) is one row
  spanning only the days inside the 31-day window, so its start moves forward
  with each run and its end is the window's. Localist's `distinct=true` gives
  the same "next occurrence" view of a recurring event.
- IU Indianapolis's own events are open to Purdue Indianapolis students (the
  owner's call on #30, 2026-10-18); the rows carry `source_key = 'iu_events'`,
  and the read path labels them "IU event" to say where they come from.
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
Jev's model, thresholds, row cap, time budget and concurrency are the
constants at the top of `src/campusEventsClassify.mjs`.
