# Campus Alerts

IU's emergency alert for the Indianapolis campus, shown in a banner at the
top of the website and the app while it is active (issue #34; the research
notes are the 2026-11-01 comments on that issue). The endpoint behind both
banners is `GET /api/campus-alert`, behind `CAMPUS_ALERTS`, off by default.
With `CAMPUS_ALERT_PUSH` on as well, each new emergency and its all clear are
pushed to phones and browsers ([Push notifications](#push-notifications),
issue #550), and a push opens the website's `/safety` page or the app's
banner.

BoilerIndy repeats an official alert; it is not an alert service. Every
banner names its source and links to PurdueALERT's text sign-up, the official
channel for Purdue students in Indianapolis.

## Where the data comes from

Purdue University in Indianapolis shares its campus with IU Indianapolis, and
IU's police (IUPD Indianapolis) cover it. IU sends an alert for each
emergency there and publishes the latest one, with no key, at:

    https://exdd-resources.webapps.iu.edu/api/public/v1/rave/indianapolis?output=json

It is CAP 1.2 as JSON and holds exactly one message, the latest. On
2026-11-01 it answered 200 (`application/json`, `X-Ratelimit-Limit: 60`, no
CORS header, so it is read server-side) with IU's all clear of 2026-09-12,
"IU Indy Alert: Campus Status Normal". That answer is the fixture
`test/fixtures/iu-alert-indianapolis.json`.

IU's public history page (`emergency.iu.edu/rave`) listed 72 Indianapolis
messages since March 2022, with alerts on 2 days in 2023, 4 in 2024, 6 in
2025 and 10 in 2026 through September 12: tornado "TAKE COVER NOW!"
messages, "dangerous situation" alerts near a garage or building, power
outages, a winter limited-operations day and the semiannual tests.

PurdueALERT is not read. Purdue's public CAP feed
(`https://www.getrave.com/cap/purdue/channel1`) is West Lafayette only, and
Purdue posts Indianapolis alerts only by text, email, desktop pop-ups and its
X account (@PurdueALERT). Reading X needs X's paid API; see "Not done yet".

## When an alert is active

The rule is IU's own. IU's banner script (`site-builder.js` on
builder-common.iu.edu) shows the latest message until one whose headline says
"Campus Status Normal" replaces it, and `src/campusAlert.mjs` does the same,
matching without regard to case. `expires` is not used: IU sets it 15 minutes
after `sent`, while an incident runs one to two hours and the Normal after a
tornado warning has come up to 11 hours later. That is why each banner shows
when the alert was sent and how long ago.

An incident usually reads: the alert ("IU Indianapolis emergency: A dangerous
situation is occurring on campus near ..."), sometimes updates, a final
("IU Indy final alert: There is no longer a threat ..."), then the Normal.
The final is still an alert, so the banner shows it until the Normal arrives.

## What the endpoint answers

`GET /api/campus-alert`, a session-free public read through the `public-read`
pair of limiters (see [RATE_LIMITS.md](RATE_LIMITS.md)):

```json
{
  "enabled": true,
  "active": true,
  "alert": {
    "id": "17892038570001397900001",
    "source": "IU Indianapolis",
    "sentAt": "2026-09-12T07:49:00.000Z",
    "headline": "IU Indy emergency: ...",
    "message": "IU Indianapolis emergency: A dangerous situation is occurring ...",
    "instruction": null,
    "severity": "Severe",
    "level": "danger",
    "test": false
  },
  "checkedAt": "2026-09-12T07:49:30.000Z",
  "stale": false
}
```

- `alert` is null unless `active`. `headline` is IU's headline; `message` is
  IU's description, or null when it only repeats the headline; `instruction`
  is IU's, when it sends one. The text is IU's, with whitespace collapsed and
  a cap of 300 characters for the headline and 2,000 for the rest. Nothing
  rewrites or summarizes it.
- `level` is how loudly to show it: `test` for a message that says TEST in
  capitals or "only a drill" (or whose CAP status is Test or Exercise),
  `warning` for Moderate and Minor (a closure, a power outage), `danger` for
  everything else, including a severity IU left Unknown.
- `checkedAt` is when IU last answered. `stale` is true once the server has
  served that answer for more than two minutes because IU could not be
  reached since; the banners then say when IU was last checked.
- With `CAMPUS_ALERTS` off it answers
  `{ enabled: false, active: false, alert: null, checkedAt: null, stale: false }`
  and never asks IU.
- With the switch on and IU unreachable before its first answer, it answers
  503 `campus_alert_unavailable` (see [api-error-codes.md](api-error-codes.md))
  and leaves IU alone for 30 s.

## Timing

| Step | Time |
|---|---|
| The server asks IU (per process, through the shared stale-on-failure cache) | at most every 15 s |
| `Cache-Control` on an answer with the switch on | `public, max-age=10, s-maxage=10, stale-while-revalidate=20` |
| The website banner polls (through Vercel's edge, only while the tab is visible) | every 30 s, and on focus |
| The app banner polls (Render directly, only while the app is in front) | every 60 s, and on returning to the app |

So a new alert usually shows on an open page within a minute. The banners are
for a student who has BoilerIndy open; the push reaches the others, within
about a minute too (below).

## The banners

Both clients show the banner only when the answer is `enabled` and `active`.
It holds the headline, the message and instruction when there are any, a
line with the source and the time sent ("IU Indianapolis alert · 3:49 AM, 12
min ago"), "Last checked" when the answer is stale, and a "Get PurdueALERT
texts" link to `https://www.purdue.edu/ehps/emergency-preparedness/purduealert-text/`.
A test reads "Test" and is shown quietly. A student can hide one alert; a new
message shows again.

- Website: `components/CampusAlertBanner.tsx`, mounted by `AppLayout`: every
  signed-in page and the four public preview pages (`/dining`, `/transit`,
  `/map`, `/free-food`), signed in or not. The landing page, which never
  calls the backend, has none, nor do the sign-in and legal pages.
  The read is `campusAlertQuery` in `lib/queries/publicData.ts`, never
  persisted to localStorage, so a banner always comes from a fresh read. A
  hidden alert is remembered for the tab only (sessionStorage).
- App: the boilerindy-app repository's banner reads the same endpoint.
- The website's `/safety` page (`pages/Safety.tsx`), where a pushed alert
  opens: the same card, without the button that hides it, or a line saying
  IU has no active alert, with when it was last checked. It is public, like
  the preview pages, so a tap opens it signed in or not, and the banner is
  not shown above it.

## Push notifications

Issue #550, item 9. `POST /api/internal/push/fast-tick`, which a pg_cron job
calls every 30 seconds (README step 57, production only), reads IU's message
through the banner's cache (`readCampusAlertCached` in `src/campusAlert.mjs`),
so the push adds no request to IU. `src/campusAlertPush.mjs` keeps each
message once in `campus_alert_messages` and groups the messages into
`campus_alert_incidents` (README step 56):

| Message | Incident | Pushed |
|---|---|---|
| The first of an emergency | opens one | `campus-alert`, to every account that has not turned campus alerts off |
| An update or a final | joins the open one | nothing; the banner changes |
| "Campus Status Normal" | closes what is open | `campus-all-clear`, for each closed incident that was pushed |
| A test (TEST in capitals, or "only a drill") | opens a test incident | to admins only (`users.is_admin` or `ADMIN_EMAILS`), all clear included |
| Anything first seen more than 30 minutes after IU sent it | as above | nothing: banner only |

- The words are IU's: the push's title credits the source ("IU Indianapolis
  alert", or "test"), its body is IU's headline, description and
  instruction, its subtitle the time IU sent it, and a tap opens
  `/safety?incident=<id>`. Nothing rewrites or summarizes an alert.
- The alert is time-sensitive and ignores quiet hours and the daily cap. The
  all clear shares the alert's tag (`campus-<incident>`), so it replaces the
  alert on the lock screen, and in a student's quiet hours it is silent.
- A phone takes them if it listed `campus-alert` when it registered, or is
  from a build before phones listed kinds; every browser of the account
  takes them too. Before README step 53 every account gets them, since
  `campus_alerts` does not exist yet.
- Once each: the alert and the all clear are claimed on the incident
  (`alert_pushed_at`, `clear_pushed_at`) before they are sent, so overlapping
  ticks or a second instance never send twice, and a tick that comes while
  the last one is still sending is skipped. An incident's id comes from its
  first message's, so a tick that failed halfway finds the same incident
  when it runs again.
- A reading the cache kept serving while IU could not be reached is not
  acted on, so an all clear only ever follows a Normal actually read.
- IU's feed holds only the latest message, so the tick can miss a Normal that
  a new message replaced within 30 seconds. An open incident therefore ends
  without an all clear when a message comes after its final, or more than 12
  hours after its last message, and that message opens a new incident. Two
  emergencies inside one incident, before IU's Normal and without a final
  between them, reach students as one push and a banner that changes.
- Turn it on: run README steps 56 and 57, then set `CAMPUS_ALERT_PUSH=on` on
  Render (with `CAMPUS_ALERTS=on`). Turn it off: `CAMPUS_ALERT_PUSH=off`
  keeps the banners; `CAMPUS_ALERTS=off` stops both.
- Check it: the log has one `[push] campus alert:` line for each message the
  tick sees for the first time, with its role, the incident and the counts.
  `select role, count(*) from campus_alert_messages group by 1;` counts what
  it has seen. An IU test shows the whole path on an admin's phone.

## Operations

- Turn it on: set `CAMPUS_ALERTS=on` on Render. Turn it off at once (the kill
  switch): set it to `off`. Render restarts with the new value, and the edge
  holds the previous answer for at most a minute.
- Check it: `curl -s https://boilerindy-api.onrender.com/api/campus-alert`.
  With the switch on it shows `checkedAt` from the last few seconds.
- A failed read logs `Campus alert unavailable:` with the reason. A refresh
  that fails while a reading is cached logs
  `[cache] campus:alert: refresh failed`, and the answer turns `stale` after
  two minutes.
- Nothing about a student is sent anywhere: the server asks IU's public feed
  and the clients ask the server. No model reads the alerts.

## Not done yet

- PurdueALERT through @PurdueALERT on X: the paid X API, polled every 30 s
  for cents a year. West Lafayette posts are dropped by their "Purdue WL"
  prefix, and posts the prefix cannot place go to Jev, the classifier the
  campus events ingest already uses. When unsure, the post is shown. Its
  report of an emergency IU already reported, within 15 minutes, is to join
  IU's incident, so a student gets one push; `campus_alert_messages` already
  takes the source `purduealert`.
- The rest of the Safety page of issue #34 (verified contacts, blue-light
  phones, Safe Walk, SafeZone) around the alert `/safety` shows today.
- Owner items from the research note: ask IU Emergency Management about
  repeating its public feed, and ask Purdue Emergency Preparedness about an
  Indianapolis CAP channel like West Lafayette's.
