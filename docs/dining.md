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

### The source is a deactivated site's API (operator note, issue #467)

`iupui.nutrislice.com` now redirects to a "Deactivated" page that says
"Indiana University - Indianapolis no longer uses Nutrislice", and
`/menu/api/settings/` reports `menus_backend_only: true` with
`primary_enterprise_name: "Chartwells US Higher Ed"` (both checked
2026-10-17). The API this module reads still answers, and Chartwells still
maintains it: lunch and dinner were republished on 2026-10-10 and menus ran
through 2026-11-27. It could be switched off without notice. The official
source is Dine On Campus, "IU Indy Eats" (`https://dineoncampus.com/iuindy/`,
menus at `/whats-on-the-menu`, hours at `/hours-of-operation`); Cloudflare
blocks it from outside the US, so it is untested (#119 item H).

What to watch:

- The snapshot's `menu_source.stale` with `reason: "not_updated"` (the newest
  `last_updated` across a hall's meals for the week is more than 28 days old)
  or `"empty_week"` (no food on any day of any meal that week). The page then
  shows a notice that links the official menu, which it links anyway.
- `ok: false` / `stale: true` snapshots or `menu_<meal>_<status>` warnings
  mean the API itself is failing, which the outage handling below covers.
- If the API goes away for good, point students at Dine On Campus and decide
  between an adapter for it (from a US network) and retiring the menus.

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
today". Question 3 (coffee shops, markets not on Nutrislice): the Campus
Center's own vendors are listed on the page (issue #477, below); places
outside the building are left to #28.

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
- `fetchMenusForSchool` keeps each meal as its own menu (`menus`, see "Meals
  and specials" below) next to the deprecated merged `stations`.
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

Under the dates, the menu weeks are cached too (issue #467). Each meal's
payload is a whole Sunday to Saturday week of 0.4 to 2.5 MB of JSON, and the
per-date cache used to download the same three weeks for each of a week's
seven dates. Now a week is fetched once per school, meal and week (keyed by
its Sunday, `weekStartYmd`), cut down to the rows the menu code reads
(`processWeek`: station headers, and foods with id, name, calories and diet
icons) and kept for `NUTRISLICE_CACHE_MS`, at most `MAX_CACHE_WEEKS` (24),
the week written longest ago dropped first. A new date in a cached week costs
only the schools list; concurrent misses share one week download; a failed
download is never kept; a forced refresh past its floor refetches the date's
weeks. A date missing from its week has no menu (it used to fall back to the
week's first day, which was another day's menu).

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

## Meals and specials (issue #466)

Each dining hall's day comes as one menu per meal, in serving order
(breakfast, brunch, lunch, dinner, then anything else), each deduped within
the meal only, so a Salad Bar food served at lunch and dinner is in both.
Every station carries `everyday`: whether it serves the same food all week.
That is learnt from the week payload the menu came with, never from station
names (`everydayStations`): a station's foods on the day are compared with the
same station's foods on the other days of that week, and a median overlap
(Jaccard) of at least 0.6 over at least two other days marks it every day. Over
the fall 2026 semester that marked Salad Bar, Daily Grill, Pizza, Hasta La
Pasta, Rice It Up and Grill Breakfast Options on every one of 83 days, and
Homestyle, Breakfast Entree Line, Chef Made Soups, Dessert and Innovation on
none. A weekend breakfast is often only Grill Breakfast Options, so a meal can
have no specials at all.

Nutrislice publishes no meal times. `src/diningMeals.mjs`, shared by the
assistant and the page, holds the clock's guess (breakfast until 10:30 AM,
lunch until 4:30 PM, dinner after, on campus time) and `defaultMeal`: the meal
being served now, else the next one posted, else the first.

The merged `stations` list stays in the snapshot, deprecated, for clients that
predate `menus` (an open tab, a persisted snapshot, the native app); the page,
Home and the assistant read `menus` and fall back to `stations` only when it
is missing.

## Dish details and diet filters (issue #468)

Each food in a week payload carries much more than the menu lists used:
`description`, `image_url` (1024 px) and `hoverpic_url` (220 px) on about 61%
of distinct foods, and `ingredients`, `serving_size_info` and
`rounded_nutrition_info` (calories, fats, cholesterol, sodium, carbs, fiber,
sugars, protein, potassium, calcium, iron, vitamins A, C and D) on all of them.
Measured on the real 2026-10-14 snapshot (196 items, 62 with a photo):

| What the per-meal items carry | Raw | Gzip |
|---|---|---|
| name, calories, icons (before) | 31.6 KB | 3.3 KB |
| plus compact facts (shipped) | 59.3 KB | 8.2 KB |
| plus everything inline | 142.2 KB | 23.4 KB |

So the snapshot's per-meal items carry the compact facts (`id`, `serving`,
`protein`, `carbs`, `fat`, `sodium`, `thumb` = `hoverpic_url`, and `desc`, the
description cut at a word to 140 characters; a fact the food lacks is left
out), and the rest comes from a session-free read when a student opens a dish:

`GET /api/dining/foods/:id?date=YYYY-MM-DD` (date optional, today by default,
the same window as `/api/dining`) answers
`{ ok, date, food: { id, name, description, image, thumb, serving, ingredients, icons, nutrition } }`,
`nutrition` keyed by Nutrislice's names (`calories`, `g_fat`, `mg_sodium`, ...)
with only the values the feed has. It reads the week cache, which the date's
snapshot filled, so it costs no upstream request; after a restart or an
eviction (`findDiningFood`) it builds the date and loads its weeks again. Only
a dish on that date's menu is found. It carries the public-read limiter pair
and `Cache-Control: public, max-age=600, s-maxage=3600`; errors use the
envelope (`dining_bad_food`, `dining_bad_date`, `dining_food_not_found`,
`dining_internal`). The deprecated merged `stations` list stays as it was.

The page: a dish's name is a button that opens a dialog with the photo when
there is one, the description, serving size, a nutrition table (main facts,
then vitamins and minerals, as published) and ingredients, plus the favorite
star when signed in. Stations where any dish has a photo show 40 px
thumbnails (`loading="lazy"`). Nothing the feed lacks is invented, and no
macro ranking is offered: some rows are implausible (Garlic Cheese Bread
Sticks: 39 g protein and 761 cal for "1 each").

**No allergen data.** The feed has no allergen icons, and `ingredients` lists
component names ("Breaded Honey Chicken^, Honey Garlic Sauce^"), not
allergens. The diet filters are the feed's own labels (Vegetarian, Vegan,
Avoiding Gluten): a dish shows when it carries every chosen label, stations
left empty hide, and the choice is remembered on the device
(`boilerindy-dining-diet-filters-v1`; per device, not per user, since the page
is public). A line beside them always says they are not allergen information
and to ask dining staff about allergies, and the dialog says the feed lists no
allergens. Dine On Campus may carry allergens (#119 item H).

## Headliners and what is coming up (issue #469)

Nutrislice has a cheap digest: for one school, meal and week,
`GET /menu/api/weeks/digest/school/<slug>/menu-type/<meal>/date/<y>/<m>/<d>/?format=json`
answers Monday to Friday, each day's few headline dishes with their photos, in
about 2.3 KB (`[{ date, menu_items: [names], images: [url or null],
holiday_text }]`; weekends are not in it). `src/diningHeadliners.mjs` reads it
for lunch and dinner, this week and the six after it, keyed by the week's
Sunday and cached for `NUTRISLICE_CACHE_MS`, keeping the last good digest
through an outage. Menus are posted about six weeks ahead (on 2026-10-17 they
ran through 2026-11-27).

`GET /api/dining/upcoming` (session-free, public-read limiter pair,
`public, max-age=600, s-maxage=1800`) merges two sources from today on:

```
{ ok, today, days: [{ date, tentative, holiday, meals: [{ meal, location, headliners: [{ name, image }], specials: [name] }] }] }
```

- `headliners` from the digest (weekdays, lunch and dinner).
- `specials` from the cached full week (`weekSpecials` in
  `src/nutrisliceDining.mjs`): the rest of the current week only, every meal
  and the weekend included, the dishes of the stations not flagged every day.
  Beyond this week only the digest's headliners are known, so a starred soup
  or dessert shows up there only within the week.
- A day more than 7 days out is `tentative`: those menus are drafts.

The page shows "Today's headliners", a photo strip for the meal on screen,
when today is a day the digest covers (a headliner on the menu opens its
details), and, signed in, "Favorites coming up": each starred dish's next day
after today ("Jamaican Jerk Chicken is back tomorrow", "... is back Thursday",
"Butter Chicken: Thu, Nov 19 (tentative)"). Home's smart alerts say when a
favorite is on today's menu or tomorrow's. The once-a-day push for favorites
is opt-in and lives with the other notifications (see
[push-notifications.md](push-notifications.md#favorite-dish-alerts-issue-469)).

## Campus Center vendors (issue #477)

The Campus Center posts no menu, so the page lists its food court vendors in
place of one: ten vendors in one card per floor (Level 1 Citizens Commons,
Level 1, Level 2), each with a few words on what it serves, a "Hours for each
vendor" button to Dine On Campus (`OFFICIAL_HOURS_URL`), and a line naming the
source and the day it was checked. Tower Dining, and a dining hall with no
menu posted, are unchanged.

- The list is static, in `boilerindy-react/src/lib/campusCenterVendors.ts`,
  rendered by `components/CampusCenterVendors.tsx` when the selected location
  is retail and its slug is `campus-center`. No request and no API change; the
  native app can copy the list if it wants it.
- Source: the Campus Center's Restaurants & Services page,
  `https://studentaffairs.indianapolis.iu.edu/campus-center/restaurants-services/index.html`,
  checked 2026-10-17. The descriptions are our own words; names are text
  only, no logos.
- That page links Dine On Campus at `https://dineoncampus.com/iui`, a slug the
  site left for `iuindy` in July 2025 (Wayback Machine), so the page links
  `https://dineoncampus.com/iuindy/hours-of-operation` instead.
- To refresh it, each semester or when a vendor changes: compare the source
  page with `CAMPUS_CENTER_VENDORS`, edit the list, and move
  `CAMPUS_CENTER_VENDORS_CHECKED` to the day you checked.

## The snapshot

```
{ ok, date, weekday, timezone, apiBase, fetchedAt, cacheTtlMs, cached, stale, cacheExpiresAt, refreshed?, missing,
  locations: [{
    id, slug, name, kind: "dining-hall" | "retail", address,
    is_open: true | false | null, hours, closes_at, opens_at, open24h,
    weekly_hours: { Monday: "7:00 AM - 9:00 PM", Saturday: "Hours not listed" | "Closed", ... }, timezone,
    meal: "Menus: breakfast, lunch, dinner" | "Menu not posted yet" | "Retail dining, no posted menu",
    menusPublished,
    menus: [{ meal: "breakfast" | "lunch" | "dinner" | ..., stations: [{ name, everyday,
      items: [{ name, calories, icons, id?, serving?, protein?, carbs?, fat?, sodium?, thumb?, desc? }] }] }],
    stations: [{ name, items: [{ name, calories, icons, meals }] }],   (deprecated: every meal merged)
    menu_source: { last_updated, stale, reason: null | "empty_week" | "not_updated" } | null,   (null for retail)
    warnings?
  }] }
```

`weekday` is the Indianapolis calendar day the snapshot was built for. The
page and the dashboard highlight that day rather than the browser's, since a
student (or the owner, on KST) can be on a different date from campus.
`?refresh=1` asks for a refetch, held to the ten-minute floor above, and only
an answer to a refresh request carries `refreshed`; `?date=YYYY-MM-DD` builds a
snapshot for another day in the window. Both go through the `public-read` rate
limiter.

## One hall's day for the app's widget (issue #549)

`GET /api/dining/today?hall=tower-dining` answers one hall's day in about a
kilobyte, built from this snapshot by `src/diningToday.mjs`: open or closed,
today's service window and the next opening as instants, and each meal's
stretch of the day by the meal windows above with up to three headline
dishes. The app's Dining widget reads it instead of the whole snapshot; the
answer, its rules and its errors are in [widget-reads.md](widget-reads.md).

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

The menu has one pill per posted meal, opening on `defaultMeal` for the
campus clock. Inside a meal, the stations that change come first (headed
"Today's specials" when there are every-day stations too), and the every-day
stations sit behind one "Every day" toggle, collapsed, or open when the meal
has nothing else. A snapshot without `menus` shows its merged stations with no
pills. Home's dining widget previews the same meal, specials first, under
"Today's lunch" (or the meal it is).

The hall and meal on screen live in the address (`?hall=tower-dining&meal=dinner`,
written with replace once a student picks a pill), so the Share button in the
header sends a link that opens the same menu, signed in or not
([share-links.md](share-links.md)).

A dining hall's header has an "Official menu" button next to the
directions, and when its `menu_source` is stale a notice above the menu says
why and links the official menu too.

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
  station, the Campus Center's real empty week, and Tower's real lunch and
  breakfast weeks of 2026-10-11 to 2026-10-17 trimmed to a few foods a day per
  station, weekends included, each trim checked to keep every station's
  every-day class): hours and status including 24-hour and past-midnight
  windows and a Saturday with a published menu, station parsing with skipped
  condiments and dedupe, the per-meal menus and the every-day rule (real weeks
  and synthetic edge cases), the snapshot for both halls with an injected
  fetch, the week cache (one download per meal for a week's seven dates,
  shared concurrent misses, TTL, forced refresh, the 24-week bound), the
  missing-day rule, the freshness flags, the compact facts and the dish
  lookup (`findDiningFood`, including a week that expired before its date),
  the cache
  (status recomputed per read, date rollover, stale-on-outage, short retry,
  per-date entries and the 16-date bound, one crawl for concurrent misses, the
  refresh floor) and the `clampDiningDate` window.
- `test/diningMeals.test.mjs`: the meal windows, serving order and the
  default meal on campus time.
- `test/diningHeadliners.test.mjs` against a real digest week
  (`nutrislice-tower-digest-lunch.json`): the parser, this week's specials,
  the merged look-ahead with its tentative days, the digest cache and outage.
  `test/diningFavoriteAlerts.test.mjs`: the alert window, matching, copy, and
  the run's claim, skip and not-configured paths.
- `boilerindy-react/src/lib/dining.test.ts`: status line (the "not known"
  state included), status dots, week grid cells, per-meal menus and the
  specials split, the diet filters and their storage, the nutrition rows,
  empty states, directions URL, campus weekday, header pill.
  `boilerindy-react/src/components/DishDialog.test.tsx`: the dish dialog.
  `test/routes/dining.test.mjs`: the dish read's limiters, cache headers and
  errors.
- `e2e/dining.spec.js`: the page against the mocked snapshot, including a
  Saturday with a posted menu, the meal tabs on a fixed clock, the official
  menu link and a stale feed's notice, the feed-down and stale states and
  favorites surviving a reload. `boilerindy-react/src/pages/Home.test.tsx` checks the
  dashboard widget and suggestion for the same Saturday, and
  `test/assistantContext.test.mjs`, `test/assistantRouter.test.mjs` and
  `test/routes/assistant.test.mjs` the assistant's three readers.
- `e2e/public-preview.spec.js` and `boilerindy-react/src/pages/Dining.test.tsx`:
  the signed-out page, with no per-user request.
