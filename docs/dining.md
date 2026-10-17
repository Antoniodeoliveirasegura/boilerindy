# Campus Dining

Menus, hours and open/closed status for the two shared dining halls (issue
#119): `GET /api/dining` and the `/dining` page, plus the dashboard tile and
the assistant's "is dining open" answer, which read the same snapshot.

## Source

Nutrislice publishes campus menus. The JSON API is
`https://iupui.api.nutrislice.com` (HTML lives on `iupui.nutrislice.com`):

- `GET /menu/api/schools/?format=json` lists the district's locations with
  per-day hours (`mon_enabled`, `mon_start`, `mon_end`, `mon_is_24_hours`, ...),
  `active_menu_types` and, in this district, empty `address` / `geolocation`.
- `GET /menu/api/weeks/school/<slug>/menu-type/<meal>/<yyyy>/<m>/<d>/?format=json`
  returns a week of `days[]`, each with flat `menu_items` rows: station headers
  (`is_section_title` / `is_station_header` with `text`) followed by `food`
  rows carrying `name`, `rounded_nutrition_info.calories` and
  `icons.food_icons` (Vegan, Avoiding Gluten, ...).

**Decision (#119 question 1):** the iupui district is the right source. It
exposes exactly two locations and both are the halls Purdue in Indianapolis
students use; no Purdue-specific district exists on Nutrislice (checked
2026-07-16 and again 2026-09-09). `NUTRISLICE_API_BASE` stays configurable in
case that changes.

| Location | slug | `active_menu_types` | What the API gives |
|---|---|---|---|
| Tower Dining | `tower-dining` | breakfast, lunch, dinner | hours + stations |
| Campus Center | `campus-center` | none (explicit empty list) | hours only |

**Decision (#119 question 2):** the Campus Center is a retail food court. A
location whose `active_menu_types` is an explicit empty list is `kind:
"retail"`: no menu is fetched for it and the page presents it as a food court
with hours, not as a hall whose menu is missing. A dining hall with nothing
posted for the day is still `kind: "dining-hall"` and says "No menu posted for
today". Question 3 (coffee shops, markets not on Nutrislice) is left to #28.

## Pipeline

`src/nutrisliceDining.mjs`, mirroring the parking and clubs modules: a pure
core, a fetch shell with an injectable fetch, and a cache.

- `pickSchools` matches the two halls by name (`LOCATION_FILTERS`, which also
  carries each hall's street address, because Nutrislice ships none).
- `mealSlugsForSchool` uses the API's list. The old breakfast / lunch / dinner
  / everyday probe is only for rows with no `active_menu_types` field at all,
  so the Campus Center no longer costs four empty menu requests per refresh.
- `ingestMenuStations` builds stations from the flat rows, drops condiment and
  topping sections, and dedupes a food that appears under several stations or
  meals.
- `deriveStatusFromSchool` decides open / closed in `America/Indiana/Indianapolis`
  (the district rows carry `timezone: null`). It handles 24-hour days, windows
  that end after midnight (11:00 AM to 2:00 AM is open at 1:00 AM, including
  the spill-over from the previous day) and missing times, and reports
  `closes_at` / `opens_at` for the status line. A day the feed flags closed
  that has a published menu is neither open nor closed (see "Weekend hours"
  below).
- `getDiningSnapshot` caches schools and menus for `NUTRISLICE_CACHE_MS`
  (default 12 h) or until the Indianapolis date changes, and recomputes the
  open / closed status on every call, so "Open now" is never hours stale.
  While Nutrislice is down the last good data keeps serving with
  `stale: true` and upstream is retried every five minutes; with nothing
  cached the endpoint answers `ok: false` and retries on the same schedule
  (it used to remember a failure for the full 12 hours).

The cache is keyed by date (issue #208): one entry per Indianapolis
`YYYY-MM-DD`, at most `MAX_CACHE_DATES` (16), the date written longest ago
dropped first, so a request for tomorrow no longer evicts today's menus.
Concurrent misses for a date share one upstream crawl, and an outage is served
and retried per date. `?refresh=1` stays public but is only a hint: it skips
the TTL once the date's last upstream attempt is at least
`MIN_REFRESH_INTERVAL_MS` (10 minutes) old; otherwise the cached snapshot comes
back with `refreshed: false`, so however many clients ask, refresh requests
cannot make a date crawl more than once per ten minutes. `?date=` must fall
between yesterday and today + 14 on the Indianapolis calendar
(`clampDiningDate`, the same 16 days as the cache bound); anything else, a
malformed date included, answers
`400 { ok: false, error: "dining_bad_date", locations: [] }`.

## Weekend hours (issue #465)

The feed's hours are not reliable. Both school rows set `sat_enabled` and
`sun_enabled` to false, yet Tower Dining publishes a full menu every Saturday
and Sunday (all 83 days from 2026-08-30 to 2026-11-20), and the All Access 7
Day meal plan is sold as access to Tower seven days a week. Both halls also
carry the same Monday to Friday 7:00 AM to 9:00 PM, which looks like a
placeholder. The official hours are on Dine On Campus ("IU Indy Eats"):
`https://dineoncampus.com/iuindy/hours-of-operation`.

So the module trusts a published menu over a closed flag, and never invents
hours:

- `fetchMenusForSchool` notes which weekdays of the fetched week (each meal's
  payload covers Sunday to Saturday) carry at least one food outside the
  skipped sections (`hasPublishedFood`), as `menuWeekdays`.
- A day flagged closed whose weekday is in `menuWeekdays` answers
  `is_open: null` with `hours: "Hours not listed"` (`HOURS_NOT_LISTED`) and no
  `opens_at` / `closes_at`, and its `weekly_hours` cell is `"Hours not listed"`
  rather than `"Closed"`. A day flagged closed with no menu is still
  `"Closed today"`; days with listed hours follow the normal rule.
- Every reader treats `null` as "not known", never as closed: the page says
  "Menu posted · hours not listed" with a neutral dot and "Not listed" in the
  week grid; Home's widget says "Menu posted" and makes no "closed right now"
  suggestion; the assistant's context says `MENU POSTED, HOURS NOT LISTED` and
  still lists the meal, its offline answer names the hall, and its briefing
  chip counts it.

The weekly hours card carries a note that the hours come from the menu feed
and may not be current, linking the official hours page.

## The snapshot

```
{ ok, date, weekday, timezone, apiBase, fetchedAt, cacheTtlMs, cached, stale, cacheExpiresAt, refreshed?, missing,
  locations: [{
    id, slug, name, kind: "dining-hall" | "retail", address,
    is_open: true | false | null, hours, closes_at, opens_at, open24h,
    weekly_hours: { Monday: "7:00 AM - 9:00 PM", Saturday: "Hours not listed" | "Closed", ... }, timezone,
    meal: "Menus: breakfast, lunch, dinner" | "Menu not posted yet" | "Retail dining, no posted menu",
    menusPublished, stations: [{ name, items: [{ name, calories, icons }] }], warnings?
  }] }
```

`weekday` is the Indianapolis calendar day the snapshot was built for. The
page and the dashboard highlight that day rather than the browser's, since a
student (or the owner, on KST) can be on a different date from campus.
`?refresh=1` asks for a refetch, held to the ten-minute floor above, and only
an answer to a refresh request carries `refreshed`; `?date=YYYY-MM-DD` builds a
snapshot for another day in the window. Both go through the `public-read` rate
limiter.

## The page

`boilerindy-react/src/pages/Dining.tsx` with the pure helpers in
`lib/dining.ts`. Everything shown comes from the feed: the status line
("Open now · until 9:00 PM", "Closed · opens 7:00 AM", "Menu posted · hours
not listed"), the "Today" pill, the weekly grid, and the directions link
(Google Maps, by the hall's street address). The hours card ends with a note
that the feed's hours may not be current and a link to the official hours
page. When the feed is down the page says so and the hours card reads
"Hours are not posted right now"; the old hardcoded 7:00 / 11:00 / 4:30 meal
times are gone, as are the unused sample-venue branch and the dead directions
button.

Signed-out visitors can open the page too (the public preview, issue #366):
they get the menus, hours and refresh, under the preview bar. The favorite
stars, the "Your favorites on today's menu" card and the "What should I eat?"
button need a session and are hidden; the favorites read waits until auth has
settled with a user, so it never answers 401 and bounces anyone to `/login`.

## Configuration

```bash
NUTRISLICE_API_BASE=   # another district or a local fixture server; default https://iupui.api.nutrislice.com
NUTRISLICE_CACHE_MS=   # schools + menus cache in ms; default 43200000 (12 h)
```

## Tests

- `test/nutrisliceDining.test.mjs` against `test/fixtures/nutrislice-*.json`
  (the real school rows, one real Tower lunch day trimmed to three foods per
  station, the Campus Center's real empty week, and Tower's real lunch week of
  2026-10-11 to 2026-10-17 trimmed to a few foods a day, weekends included):
  hours and status including 24-hour and past-midnight windows and a Saturday
  with a published menu, station parsing with skipped condiments
  and dedupe, the snapshot for both halls with an injected fetch, the cache
  (status recomputed per read, date rollover, stale-on-outage, short retry,
  per-date entries and the 16-date bound, one crawl for concurrent misses, the
  refresh floor) and the `clampDiningDate` window.
- `boilerindy-react/src/lib/dining.test.ts`: status line (the "not known"
  state included), status dots, week grid cells, empty states, directions URL,
  campus weekday, header pill.
- `e2e/dining.spec.js`: the page against the mocked snapshot, including a
  Saturday with a posted menu, the feed-down and stale states and favorites
  surviving a reload. `boilerindy-react/src/pages/Home.test.tsx` checks the
  dashboard widget and suggestion for the same Saturday, and
  `test/assistantContext.test.mjs`, `test/assistantRouter.test.mjs` and
  `test/routes/assistant.test.mjs` the assistant's three readers.
- `e2e/public-preview.spec.js` and `boilerindy-react/src/pages/Dining.test.tsx`:
  the signed-out page, with no per-user request.
