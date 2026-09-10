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
  `closes_at` / `opens_at` for the status line.
- `getDiningSnapshot` caches schools and menus for `NUTRISLICE_CACHE_MS`
  (default 12 h) or until the Indianapolis date changes, and recomputes the
  open / closed status on every call, so "Open now" is never hours stale.
  While Nutrislice is down the last good data keeps serving with
  `stale: true` and upstream is retried every five minutes; with nothing
  cached the endpoint answers `ok: false` and retries on the same schedule
  (it used to remember a failure for the full 12 hours).

## The snapshot

```
{ ok, date, weekday, timezone, apiBase, fetchedAt, cacheTtlMs, cached, stale, cacheExpiresAt, missing,
  locations: [{
    id, slug, name, kind: "dining-hall" | "retail", address,
    is_open, hours, closes_at, opens_at, open24h, weekly_hours: { Monday: "7:00 AM - 9:00 PM", ... }, timezone,
    meal: "Menus: breakfast, lunch, dinner" | "Menu not posted yet" | "Retail dining, no posted menu",
    menusPublished, stations: [{ name, items: [{ name, calories, icons }] }], warnings?
  }] }
```

`weekday` is the Indianapolis calendar day the snapshot was built for. The
page and the dashboard highlight that day rather than the browser's, since a
student (or the owner, on KST) can be on a different date from campus.
`?refresh=1` forces a refetch; `?date=YYYY-MM-DD` builds a snapshot for
another day. Both go through the `public-read` rate limiter.

## The page

`boilerindy-react/src/pages/Dining.tsx` with the pure helpers in
`lib/dining.ts`. Everything shown comes from the feed: the status line
("Open now · until 9:00 PM", "Closed · opens 7:00 AM"), the "Today" pill, the
weekly grid, and the directions link (Google Maps, by the hall's street
address). When the feed is down the page says so and the hours card reads
"Hours are not posted right now"; the old hardcoded 7:00 / 11:00 / 4:30 meal
times are gone, as are the unused sample-venue branch and the dead directions
button.

## Configuration

```bash
NUTRISLICE_API_BASE=   # another district or a local fixture server; default https://iupui.api.nutrislice.com
NUTRISLICE_CACHE_MS=   # schools + menus cache in ms; default 43200000 (12 h)
```

## Tests

- `test/nutrisliceDining.test.mjs` against `test/fixtures/nutrislice-*.json`
  (the real school rows, one real Tower lunch day trimmed to three foods per
  station, the Campus Center's real empty week): hours and status including
  24-hour and past-midnight windows, station parsing with skipped condiments
  and dedupe, the snapshot for both halls with an injected fetch, and the cache
  (status recomputed per read, date rollover, stale-on-outage, short retry).
- `boilerindy-react/src/lib/dining.test.ts`: status line, empty states,
  directions URL, campus weekday, header pill.
- `e2e/dining.spec.js`: the page against the mocked snapshot, including the
  feed-down and stale states and favorites surviving a reload.
