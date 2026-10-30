# Widget reads

The small public reads the app's Home Screen widgets and Siri call: the next
buses at a stop with the stop list behind the widget's picker, and one dining
hall's day (issue #549, for the app's #173). A widget fetches on WidgetKit's
schedule, a few dozen times a day, with no session, and draws from one small
answer, so these answer in a kilobyte or so where `/api/transit/vehicles`
wants polling every 5 seconds and `/api/dining` is 56 KB.

| Route | Answer | Cache | Limiter |
|---|---|---|---|
| `GET /api/transit/places` | Every stop as a place, each route with its hours: `{ places: [{ key, name, lat, lon, routes }] }`, about 16 KB | 10 min in the server, `public, max-age=60, s-maxage=600, stale-while-revalidate=600`, like `/api/transit/stops` | `public-read` |
| `GET /api/transit/arrivals?stop=<key>` | The next buses at one place | 15 s per place in the server, `public, max-age=15` | `widget-read` |
| `GET /api/dining/today?hall=<slug>` | One hall's day | As `/api/dining`: `public, max-age=120, s-maxage=300` | `public-read` |

All three are session-free and registered ahead of the session middleware
(issue #250), like the other public reads. Errors use the standard envelope;
the codes are in [api-error-codes.md](api-error-codes.md). The widgets call
Render directly, as the app does, so the edge cache never sees them.

Every time in these answers is ISO 8601 in UTC to the second with no
fraction (`2026-10-28T12:46:00Z`), which Swift's `JSONDecoder` reads with its
`.iso8601` strategy; that strategy refuses the milliseconds other answers
carry.

## Places

TransLoc's stops feed lists one row per stop per route (`RouteStopID`), so
Riverwalk Apartments is three rows, on Crimson, Gray and Orange, and Michigan
and Blackford five. A place is the rows that share a name, ignoring case,
spacing and the kind of dash, within 150 m of each other: Gray runs the
opposite way round the loop and stops on the other side of the street, 20 to
63 m from the other routes' rows for the same stop, and those are one place.
On 2026-10-29 the feed's 75 rows made 41 places.

The key is the name in lowercase with hyphens (`riverwalk-apartments`), so it
survives TransLoc renumbering a route; a name that turns up again farther away
becomes `<key>-2`, and so on, in feed order. Routes carry the RouteID shown on
the map and the number, name and color from GetRoutes; a hidden variant such
as "Route 1 - Crimson Estimated Times_april2025" counts as the route with its
number, as the website's route map does. Built in `src/transitPlaces.mjs`.

```json
{ "key": "riverwalk-apartments", "name": "Riverwalk Apartments", "lat": 39.773819, "lon": -86.185254,
  "routes": [
    { "routeId": 31, "routeNum": "1", "routeName": "Crimson", "color": "#990000",
      "hours": { "days": [1, 2, 3, 4, 5], "start": "06:30", "end": "22:00", "label": "Mon-Fri 6:30a-10:00p" } },
    { "routeId": 19, "routeNum": "2", "routeName": "Gray", "color": "#83786F",
      "hours": { "days": [1, 2, 3, 4, 5], "start": "06:30", "end": "22:00", "label": "Mon-Fri 6:30a-10:00p" } },
    { "routeId": 34, "routeNum": "7", "routeName": "Orange", "color": "#E68217",
      "hours": { "days": [0, 6], "start": "09:00", "end": "20:00", "label": "Sat-Sun 9:00a-8:00p" } } ] }
```

### Route hours

Each route carries `hours`, its timetable from `src/transitHours.mjs`: the
table the website's Transit page reads too, so the two never disagree, and a
semester's new hours change there and reach the app's widgets and Siri
without an app build.

- `days`: the weekdays it runs, `0` Sunday to `6` Saturday.
- `start` and `end`: 24-hour `HH:MM` on the campus clock,
  `America/Indiana/Indianapolis`, whatever time zone the phone is in. An
  `end` of `"00:00"` is the midnight that ends the day (Yellow and Blue run
  until then); no route runs past midnight, so a day's service never spills
  into the next.
- `label`: the hours as the website writes them, ready to show.
- The table is keyed by the printed route number, so the hours hold when
  TransLoc renumbers a route. A route with no hours on file, a charter or a
  route new to the feed, has `"hours": null`: treat it as one that may run at
  any time.
- The arrivals read's `place.routes` carries the same `hours`, so a widget
  that only fetches arrivals has them; the arrivals themselves do not.

The hours are the timetable, not the last word: a bus reporting on its route
outside them (weekend specials and extended service happen) still shows up
in the arrivals, and the website lets a live bus win over the hours (#373).
Do the same: show an arrival whatever the hours say, and let the hours speak
only when no bus is coming.

**When a route next starts.** A route is in service when, on the campus
clock, today's weekday is in `days` and `start <= now < end` (reading an
`end` of `"00:00"` as 24:00). Its next start is the first start after now:
try today and then each following day, up to seven days on, and take the
first whose weekday is in `days` and whose `start` is still ahead (today's
counts only before its `start`). Make that instant from the campus date and
the `HH:MM` in the campus time zone (in Swift, a `Calendar` with that
`TimeZone`) rather than by adding hours to now, so the days the clocks change
come out right: at 7:00 AM on Saturday 2026-10-31 (EDT), Purple next starts
on Monday 2026-11-02 at 7:00 AM EST, `2026-11-02T12:00:00Z`, which is 49 hours
later, not the 48 that two days would make. A widget showing a route off
hours can ask WidgetKit for its next timeline at that instant. On the server,
`zonedTimeMs` in `src/campusTime.mjs` makes the same instant.

## Arrivals

```json
{
  "place": { "key": "riverwalk-apartments", "name": "Riverwalk Apartments", "routes": ["...as in places"] },
  "fetchedAt": "2026-10-30T10:40:26Z",
  "arrivals": [
    { "routeId": 34, "routeNum": "7", "routeName": "Orange", "color": "#E68217", "at": "2026-10-30T10:50:26Z", "source": "position", "vehicleId": 41 },
    { "routeId": 19, "routeNum": "2", "routeName": "Gray", "color": "#83786F", "at": "2026-10-30T10:50:33Z", "source": "transloc", "vehicleId": 12 },
    { "routeId": 31, "routeNum": "1", "routeName": "Crimson", "color": "#990000", "at": "2026-10-30T10:51:43Z", "source": "transloc", "vehicleId": 28 }
  ]
}
```

(Gray and Crimson are TransLoc's estimates of that morning; the Orange bus
five stops away is made up, as Orange had not started.)

- Sorted by `at`, at most the next two per route and eight in all. A place
  with no bus coming answers `arrivals: []`.
- `vehicleId` is the bus: the vehicles feed's `VehicleID`, which TransLoc's
  estimates name too, so a client can put a time on a bus it draws (the
  website's Home does). `null` when neither named one.
- `source: "transloc"` is TransLoc's own estimate (`GetStopArrivalTimes` for
  the place's route stops). A route TransLoc gives no estimate for gets the
  position-based one, `source: "position"`: the stops between each bus on the
  route and the place, times two minutes (`src/transitEta.mjs`, ported from
  the website's `describeBusEta`). A bus more than 300 m from every stop of
  its route, or flagged off its route, gets none. A bus counts as at its
  route's nearest stop, except where the route passes the same spot twice:
  Blue and Yellow serve 404 Lot (inbound and outbound stops 13 m apart) and
  16 Tech (31 m) on two passes of the loop. There a moving bus's `Heading`
  picks the pass whose way into or out of its stop lies closest to it; a
  stopped bus reports heading 0, which says nothing, so it keeps the nearest
  stop. On 2026-10-30 a Yellow bus arriving at 404 Lot-Inbound was counted
  from the outbound stop, 18 minutes from Michigan and Blackford where
  TransLoc said 5; with its heading it reads 6. It is still a rough estimate;
  how far off it runs is #549 item 3's shadow week.
- One fill per place every 15 seconds at most, through the server's shared
  cache, however many widgets show it; the bus positions come from the same
  4 s cache as `/api/transit/vehicles`.
- While TransLoc is down the last good answer keeps serving, with its own
  `fetchedAt`, so the widget can tell how old it is. Positions more than a
  minute old are not used for a new answer. With no estimates, no current
  positions and no earlier answer the read answers 503 `transit_unavailable`.
- A failing or unreadable estimates call is logged (`TransLoc arrivals: ...`,
  a warning, not a Sentry event) at most every 10 minutes.

### TransLoc's answer

The request is
`GetStopArrivalTimes?apiKey=<key>&routeStopIDs=<the place's RouteStopIDs>&timesPerStop=2`.
As the JagLine relay answered it on 2026-10-30 (the trimmed sample is on #549
and in `test/fixtures/transloc-stop-arrival-times.json`):

- One row per route stop with a bus coming: `RouteId`, `RouteStopId` (the
  stops feed's `RouteStopID`, the same numbers), `StopId`, the stop and route
  names and a `Times` list with one entry per bus: `Seconds` to the arrival,
  `EstimateTime` and `Time` (the same `/Date(ms)/`), `IsArriving` (with
  `Text: "Arriving"`, up to about 30 seconds out: a second sampler saw it at 0
  to 30 s in 23 of 723 times, and never from 35 s), `IsDeparted` and
  `VehicleId`. The `Scheduled...` fields were all null.
- The filter is honoured: Michigan and Blackford's five route stops brought
  back the one row of 29 with a bus coming. `timesPerStop` does not cap the
  list: with `timesPerStop=1`, Yellow at Michigan and Blackford still came
  back with both its buses, so the two per route is the server's own cap.
- With no bus running the answer is `[]`, and a place whose routes have not
  started yet gets `[]` too.
- `EstimateTime` agreed with `Seconds` to the second. The vehicles feed's
  `TimeStamp` (`/Date(ms-0600)/`) is no clock: its ms is six hours plus that
  row's `Seconds` past the answer (30 answers of 9 buses, 2026-10-30), so the
  parser still reads `Seconds` first: it does not lean on the relay's clock.
  A vehicles row's own `Seconds` is how long before the answer the bus last
  reported, and `/api/transit/vehicles` grows it by the age of the copy it
  sends (`src/transitVehicles.mjs`), so a copy served while TransLoc is down
  reads as old.

The parser (`src/transitArrivals.mjs`) keeps a time only for a tracked bus
(an `EstimateTime` or a `VehicleId`: a schedule-only time would be left out),
drops departed buses and anything more than a minute past or two hours
ahead, and never throws. An answer it cannot read leaves every route to the
position estimate and logs a warning.

## One hall's day

```json
{
  "date": "2026-10-14",
  "hall": { "slug": "tower-dining", "name": "Tower Dining", "kind": "dining-hall" },
  "open": true,
  "opensAt": "2026-10-14T11:00:00Z",
  "closesAt": "2026-10-15T01:00:00Z",
  "nextOpening": { "date": "2026-10-15", "at": "2026-10-15T11:00:00Z", "meal": "breakfast",
                   "headliners": [{ "station": "Breakfast Entree Line", "dish": "Scrambled Eggs" }] },
  "meals": [
    { "meal": "breakfast", "from": "2026-10-14T11:00:00Z", "until": "2026-10-14T14:30:00Z", "headliners": ["..."] },
    { "meal": "lunch", "from": "2026-10-14T14:30:00Z", "until": "2026-10-14T20:30:00Z",
      "headliners": [{ "station": "Homestyle", "dish": "Honey Garlic Fried Chicken" },
                     { "station": "Chef Made Soups", "dish": "Chicken Miso Soup" },
                     { "station": "Dessert", "dish": "Chocolate Soft Serve Ice Cream" }] },
    { "meal": "dinner", "from": "2026-10-14T20:30:00Z", "until": "2026-10-15T01:00:00Z", "headliners": ["..."] }
  ]
}
```

Built in `src/diningToday.mjs` from the snapshot `/api/dining` serves, so the
two agree at the same moment: `open` is the snapshot's `is_open` (`null` on a
day the feed flags closed but that has a menu, [dining.md](dining.md#weekend-hours-issue-465)),
and the clock times of `closesAt` and `opensAt` are its `closes_at` and
`opens_at`.

- `hall` takes the hall's slug, or its first word when no other hall's slug
  starts with it: `tower` is `tower-dining`.
- `opensAt` and `closesAt` are the service window `now` falls in or comes
  before (yesterday's, while one that runs past midnight is still open);
  `null` when today lists no times.
- `nextOpening` is the next opening after that window closes, or after now
  when the hall is closed, with the meal served then and its headliners, read
  from that date's snapshot. A later day that lists no times but has a menu
  comes back with `at: null`. `null` when nothing opens within a week.
- `meals` are the day's posted meals in serving order, each with its stretch
  of the day by the app's meal windows (`src/diningMeals.mjs`: breakfast
  until 10:30 AM, lunch until 4:30 PM, dinner after, as Dining's default
  tab chooses them), cut to the hall's hours. The day never steps back to an
  earlier meal, so an evening with no dinner has no meal. Without listed times
  the first meal has no `from` and the last no `until`.
- `headliners` are the first dish of each station not served every day
  (issue #466), at most three per meal.

A whole day at Tower is about 1.2 KB. The answer names only the headliners,
so the widget's starred-dish line cannot be matched from it alone; the app
can write the day's starred dishes that are on the menu to the App Group when
it loads `/api/dining`.

## Tests

`test/transitPlaces.test.mjs`, `test/transitHours.test.mjs`,
`test/transitEta.test.mjs`, `test/transitArrivals.test.mjs`,
`test/diningToday.test.mjs` and `test/campusTime.test.mjs` cover the pure
parts against the JagLine feeds of
2026-10-29 (`test/fixtures/transloc-stops.json`, `transloc-routes.json`), its
arrival estimates of 2026-10-30 (`transloc-stop-arrival-times.json`) and the
saved Nutrislice weeks; `test/routes/campus.test.mjs` and
`test/routes/dining.test.mjs` the routes, their limiters, cache headers and
the stale answer.
