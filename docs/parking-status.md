# Parking Status

Live garage availability for Purdue Indianapolis students (issue #14): the
`/parking` page, the "Parking" layer on the campus map, and the
`GET /api/parking/garages` endpoint behind both.

## Where the data comes from

Purdue Indy parking is run by IU Indianapolis Parking & Transportation.
Students buy ST (commuter) or NCS (north campus) permits from IU with their IU
login, and an ST permit is valid in six garages. IU publishes a public,
login-free page with live counts for exactly those six:

    https://v2.aitapps.iu.edu/INPARK_LotCount_V1_Online/IN

It is server-rendered HTML (no JSON variant, no API key). Each garage has an
info-window block (name, address, rates, capacity, occupied, available,
timestamp) and the page embeds a Google-Maps marker array with lat/lng and a
fill-level icon (`icon-10P` ... `icon-90P`, `icon-Full`). The page is an
unofficial source: nothing guarantees its format, which is why the parser is
fixture-tested and the API degrades instead of failing.

The static garage table and the permit rules come from
`parking.indianapolis.iu.edu` (locations and permits pages, reviewed
2026-09-03). If IU changes permit rules, update `PERMIT_INFO` in
`src/parkingStatus.mjs`.

## Pipeline

- `src/parkingStatus.mjs` is the pure core: `buildSnapshot(html, { now })`
  parses the page, merges each garage onto the static table by its first word
  (`Lockefield Student Garage` -> `lockefield`), normalizes the counts, and
  sorts known garages by available spaces with unknown ones last.
  `fetchParkingStatus()` is the thin shell around `fetch` with a 10 s timeout.
- `server.mjs` serves `GET /api/parking/garages` through the `public-read`
  rate limiter and the in-memory TTL cache (`PARKING_STATUS_CACHE_MS`,
  default 60 s, floor 15 s), so IU sees at most one request per TTL.
- `boilerindy-react/src/lib/parking.ts` holds the client types and formatting
  helpers; `pages/Parking.tsx` is the page; `components/map/ParkingGarageLayer.tsx`
  draws the pins, switched by the shared layer toggle (`components/map/mapLayers.ts`,
  issue #158). `/map?layer=parking` opens the map with the layer on.

## Normalization rules

- `occupied` is clamped to `[0, capacity]` and `available` is recomputed as
  `capacity - occupied`. The page's own "Available" can exceed capacity when a
  sensor drifts negative (Lockefield reported -1 occupied / 484 of 483).
- A garage with no `Occupied`/`Available` lines is reported with `null` counts
  and `status: 'unknown'`, even if its marker icon says `icon-Full`. Seen at
  2:46 AM on Barnhill: that is missing data, not a full garage.
- `status`: `full` when 10 or fewer spaces remain or occupancy is 90% or more,
  `busy` at 70% or more, otherwise `open`; `unknown` without counts.
- `updatedAt` converts the page's Indianapolis-local timestamp to ISO-8601 UTC
  (`America/Indiana/Indianapolis`, DST-aware). `stale` is true when it is more
  than 30 minutes old.

## Degraded mode

`fetchParkingStatus` never throws. A timeout, a non-2xx response, or a page
without garage blocks returns `{ ok: false, error, garages, permits }` where
`garages` is the static six with `status: 'unknown'` and null counts. The page
shows a banner and the list without occupancy; the map layer keeps the pins.
The degraded snapshot is cached for the same TTL so a broken upstream is not
hammered.

## Response shape

```json
{
  "ok": true,
  "source": "iu-parking-lotcount",
  "sourceUrl": "https://v2.aitapps.iu.edu/INPARK_LotCount_V1_Online/IN",
  "fetchedAt": "2026-09-04T06:50:00.000Z",
  "garages": [
    {
      "id": "riverwalk", "name": "Riverwalk Garage", "sourceName": "Riverwalk Garage",
      "code": "XP", "address": "245 University Blvd", "type": "Permit and visitor",
      "stRule": "ST spaces only", "lat": 39.77010216, "lng": -86.17402427,
      "capacity": 1584, "occupied": 6, "available": 1578, "percentFull": 0,
      "status": "open", "icon": "icon-10P", "updatedAt": "2026-09-04T06:46:42.000Z", "stale": false
    }
  ],
  "permits": { "reviewedOn": "2026-09-03", "permits": [], "links": [], "notes": [] }
}
```

## Tests and fixtures

- `test/parkingStatus.test.mjs` runs against `test/fixtures/inpark-lotcount.html`,
  a real capture of the page (the embedded Google Maps key is redacted). It
  covers the parse, the clamping and unknown cases, timestamp conversion in
  both DST states, missing markers, the format-change path, and the fetch
  shell's degraded results.
- To refresh the fixture: fetch the page, replace `key=...` in the script tag
  with `key=REDACTED`, save it over the fixture, and re-run the test. Expect to
  update the count assertions.
- `boilerindy-react/src/lib/parking.test.ts` covers the client formatters;
  `e2e/parking.spec.js` drives the page against the mock backend.

## Not covered yet

Surface lots (ST/NC/EM) have no live counts on IU's page, so the app lists
only the six garages. Adding the lot directory (addresses and permit types
from IU's locations page) would be a static follow-up.
