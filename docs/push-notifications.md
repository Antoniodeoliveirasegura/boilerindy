# Push Notifications

Web Push for deadline reminders (issue #9): the "Push notifications" card on
`/settings`, the `/api/push/*` routes behind it, and a reminder runner that the
Supabase scheduler triggers every 5 minutes. Departure alerts (#44) will reuse
the same delivery path. The native app registers Expo push tokens at
`/api/me/push-token` and gets the same reminders and test sends through
Expo's push service (issue #194): see [Native devices (Expo)](#native-devices-expo).
A phone that schedules its reminders itself gets no deadline reminders from
the server: see [Phones with local reminders](#phones-with-local-reminders).
Every notification belongs to a kind of the kind registry (issue #550), which
sets how loud it is, how it stacks and how long it is worth delivering: see
[Kind registry](#kind-registry). IU's campus alerts go out from a second,
faster tick: see [The fast tick](#the-fast-tick-campus-alerts).
The same tick keeps Track this bus, the app's Live Activity, current over
APNs: see [Track this bus](#track-this-bus-the-live-activity).

## How it fits together

1. The browser registers `public/sw.js` (production builds only) and, when the
   student turns notifications on, asks the push service for a subscription
   using the server's VAPID public key from `GET /api/push/config`.
2. The subscription (endpoint URL plus the browser's `p256dh` and `auth` keys)
   is stored in `push_subscriptions`, one row per device, keyed by endpoint.
3. Every 5 minutes the pg_cron job in `db/supabase-push.sql` calls
   `POST /api/internal/push/run-reminders` with the `PUSH_CRON_SECRET` bearer
   token. The runner (`src/pushReminders.mjs`) finds items due within each
   user's lead time, claims them in `push_deliveries`, and sends one encrypted
   message per device.
4. The service worker shows the notification; tapping it opens the task it
   names, `/assignments?taskId=<id>&taskKind=calendar|manual`, where the
   Assignments page opens that task's details.

### When a channel ends

A browser subscription or a phone token belongs to the account, not to the
session that registered it, so each one is ended on purpose:

- **Sign-out.** The web app unsubscribes the browser and deletes its row
  (`unsubscribeThisDevice`) before it ends the session, so on a shared computer
  the next person sees none of the student's reminders. The phone app removes
  its token at sign-out the same way. The student turns notifications on again
  after signing back in.
- **Password change.** A new password, from Settings or a reset link, ends
  every channel of the account (`forgetPushChannels` in
  `src/pushChannels.mjs`), as it ends every older session (#132). Without
  that, an endpoint or token planted through a stolen session kept receiving
  the student's reminders after the password changed. The browser that made
  the change registers its own subscription again right away
  (`reregisterThisDevice`), and the phone app registers again on its next
  launch.

The push protocol is implemented in `src/webPush.mjs` with `node:crypto` only:
VAPID (RFC 8292) ES256 tokens and `aes128gcm` payload encryption (RFC 8291 and
RFC 8188). `test/webPush.test.mjs` pins the encryption to the RFC 8291
Appendix A vector, so a refactor cannot silently break interoperability with
Chrome, Firefox, Edge or Safari.

## One-time setup (owner)

1. Generate keys: `pnpm run vapid:generate`. Set `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY` and (optionally) `VAPID_SUBJECT` on Render and in your
   local `.env`. Without them every route reports `enabled: false`.
2. Run `db/supabase-push.sql` in the Supabase SQL Editor. Until then the routes
   answer `503 push_not_configured` and the Settings card says so.
3. Set `PUSH_CRON_SECRET` on Render (`openssl rand -hex 32`), then schedule the
   reminder job with the block at the bottom of `db/supabase-push.sql`. It needs
   the `pg_cron` and `pg_net` extensions from `db/supabase-keep-warm.sql`.
4. Turn notifications on for your own device in Settings and press "Send a test
   notification".
5. Run `db/supabase-push-kinds.sql` (README step 53, issue #550) for the
   choices by kind: the evening list, quiet hours and the daily cap. Until
   then the Settings card and the reminder run work as before ([Choices by
   kind](#choices-by-kind-the-evening-list-quiet-hours-and-the-daily-cap)).
6. For Track this bus: run `db/supabase-live-activities.sql` (README step 58),
   create an APNs auth key, and set `APNS_KEY_P8`, `APNS_KEY_ID` and
   `APNS_TEAM_ID` on Render ([Track this bus](#track-this-bus-the-live-activity)).

Rotating the VAPID pair invalidates every subscription; users will need to turn
notifications on again on each device.

## Environment variables

| Variable | Purpose |
|---|---|
| `VAPID_PUBLIC_KEY` | 65-byte P-256 point, base64url. Shipped to browsers. |
| `VAPID_PRIVATE_KEY` | 32-byte scalar, base64url. Secret; signs every push request. |
| `VAPID_SUBJECT` | `mailto:` or `https:` contact for push services. Default `mailto:support@boilerindy.app`. |
| `PUSH_CRON_SECRET` | Bearer token for the reminder runner. Blank means the route falls through to the JSON 404. |
| `PUSH_KINDS_OFF` | Kind ids from the [kind registry](#kind-registry), separated by commas, that the server stops sending. Blank sends every kind. See [Stopping a kind](#stopping-a-kind-push_kinds_off). |
| `EXPO_ACCESS_TOKEN` | The project's Expo access token, sent with every native push for Expo's enhanced push security. Blank sends none. Set it before turning that setting on: see [Native devices (Expo)](#native-devices-expo). |
| `CAMPUS_ALERT_PUSH` | `off` by default. With `CAMPUS_ALERTS` on too, the fast tick pushes IU's campus alerts. See [The fast tick](#the-fast-tick-campus-alerts). |
| `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID` | The APNs auth key that signs Track this bus's updates: the `.p8` file's contents (its line breaks, or `\n` for each), its 10-character key id, and the 10-character team id. All three or none; blank leaves Track this bus off. Secret: never logged or returned. See [Track this bus](#track-this-bus-the-live-activity). |

The server validates the pair at boot (length, curve membership, and that the
public key matches the private one) and logs a clear error instead of sending
requests that push services would reject with 403.

## API

All routes except `config`, `/api/live-activities`, `run-reminders` and `fast-tick` require a signed-in session.

| Route | Purpose | Notes |
|---|---|---|
| `GET /api/push/config` | `{ enabled, publicKey, kinds: { version, digest }, campusAlertPush, liveActivities }` | Public; `public-read` rate limit. `kinds` is the [kind registry](#kind-registry)'s version and digest, reported with push on or off. `campusAlertPush` is true while campus alerts are pushed (push on, and `CAMPUS_ALERTS` and `CAMPUS_ALERT_PUSH` on), so a client offers that choice only then. `liveActivities` is true while Track this bus runs (the `APNS_*` variables set, push on, and `bus-live-activity` not in `PUSH_KINDS_OFF`), so the app offers it only then. |
| `GET /api/push/settings` | `{ enabled, settings: { deadlineReminders, leadMinutes, diningFavoriteAlerts, classReminders, classLeadMinutes, digestMinute, deadlineItems, quietStart, quietEnd, campusAlerts, kindsMigrated }, diningAlertsAvailable, kindsAvailable, subscriptions: [{ id, createdAt, userAgent, lastUsedAt }], devices: [{ id, platform, deviceName, createdAt, lastSeenAt, localReminders, kinds }] }` | Endpoints and tokens are never returned. `devices` is empty until `db/supabase-push-devices.sql` runs; `diningAlertsAvailable` is false until `db/supabase-dining-favorite-alerts.sql` runs; `kindsAvailable` is false until `db/supabase-push-kinds.sql` runs, and until then the choices by kind read what that step will give the account; `localReminders` is false for every phone until `db/supabase-push-local-reminders.sql` runs. |
| `PUT /api/push/settings` | Body `{ deadlineReminders?, leadMinutes?, diningFavoriteAlerts?, classReminders?, classLeadMinutes?, digestMinute?, deadlineItems?, quietStart?, quietEnd?, campusAlerts?, kindsMigrated? }`; answers `{ settings, diningAlertsAvailable, kindsAvailable }` | `leadMinutes` 5 to 10080; `classLeadMinutes` 5, 10, 15 or 30; `digestMinute`, `quietStart` and `quietEnd` minutes past midnight on campus (0 to 1439) or null; quiet hours change as a pair, a null pair for none; `kindsMigrated` only `true`, which stamps the account once. An evening list inside quiet hours answers 400. `push-write` limit. Shared by browsers and phones. `diningFavoriteAlerts` before its migration answers 503 `dining_alerts_schema_missing`, and a choice by kind before step 53 503 `push_kinds_schema_missing`. |
| `POST /api/push/subscriptions` | Body `{ subscription, userAgent }`, returns 201 | Upsert by endpoint; at most 10 devices per user. The endpoint must be an https URL on a browser push service (`PUSH_SERVICE_HOSTS` in `src/webPush.mjs`: FCM, Mozilla autopush, Apple, WNS) with the default port and no credentials, or the answer is 400. The sender applies the same check, so a stored row on any other host is deleted as gone at its next send, and it never follows a redirect. |
| `DELETE /api/push/subscriptions` | Body `{ endpoint }`, returns `{ removed }` | |
| `POST /api/me/push-token` | Body `{ token, platform, deviceName?, localReminders?, kinds?, channels?, kindsVersion?, redact?, activityStartToken? }`, returns 201 `{ device: { id, createdAt, localReminders, kinds, channels, kindsVersion, redact } }` | The native app. Upsert by token; at most 10 phones per user. `localReminders` defaults to false, and every registration replaces it and the rest. `push-write` limit. See [Native devices (Expo)](#native-devices-expo), [What a phone takes](#what-a-phone-takes-kinds-and-channels) and [Phones with local reminders](#phones-with-local-reminders). |
| `DELETE /api/me/push-token` | Body `{ token }`, returns `{ removed }` | Only the student's own phone. `push-write` limit. |
| `POST /api/push/test` | Returns `{ sent, failed, removed }` | Every browser and phone the student registered. `push-test` limit (10 per hour). 503 `push_kind_off` while `PUSH_KINDS_OFF` lists `test`. |
| `POST /api/internal/push/run-reminders` | Returns the run summary | `Authorization: Bearer <PUSH_CRON_SECRET>`. A Supabase 5xx or timeout is retried once after 1.5 s; one that persists answers 503 and the next tick tries again (issue #242). |
| `POST /api/internal/push/fast-tick` | Returns `{ campusAlerts, liveActivities }`, the summaries of the campus alert run and the Live Activity run, or `{ skipped: 'busy' }` | The same bearer token and retry, each half retried on its own. Every minute ([below](#the-fast-tick-campus-alerts)); a half that is off answers `{ ok: false, reason: 'off' }`, and with both off the tick reads nothing. |
| `POST /api/live-activities` | Body `{ activityId, token, env, stop, routeId? }`, returns 201 `{ endsAt }`, or 200 with the same `endsAt` for an activity sent again | Track this bus: the app's Live Activity, signed in or out. `widget-read` limits. 503 `live_activity_disabled` while it is off, 409 `live_activity_ended` for an activity already over. See [Track this bus](#track-this-bus-the-live-activity). |
| `PATCH /api/live-activities/:activityId` | Body `{ token }`, returns `{ endsAt }` | The activity's new push token. 404 `live_activity_not_found` once it is over. |
| `DELETE /api/live-activities/:activityId` | Returns `{ ended }` | The student ended it on the phone; no more pushes. Answers even while Track this bus is off. |

Error shape follows the rest of the API: `{ error: { message, status, code? } }`.
`code` is `push_not_configured` (tables missing, 503), `push_disabled` (no
VAPID keys, 503), or on the test send `push_kind_off` (`PUSH_KINDS_OFF` lists
`test`, 503). On `/api/me/push-token` a missing `push_devices` table is
`push_not_configured` too, with a message that names
`db/supabase-push-devices.sql`. The Live Activity routes answer
`live_activity_disabled`, `live_activities_schema_missing`,
`live_activity_ended` and `live_activity_not_found`
([api-error-codes.md](api-error-codes.md)).

## Notification payload

The encrypted body is JSON:

```json
{ "title": "Assignment due in 45 min", "body": "HW 3 is due at 10:45 AM.", "url": "/assignments?taskId=<id>&taskKind=calendar", "tag": "deadline-calendar-<id>", "kind": "deadline", "itemId": "<id>", "itemKind": "calendar", "expiresAt": "2026-09-08T14:45:00.000Z" }
```

`tag` doubles as the push `Topic` header, so a device that was offline gets
only the latest message per item. `kind` is always a kind id from the
[kind registry](#kind-registry). The fields by kind (issue #550, items 2 and
5):

| Field | On | What it is |
|---|---|---|
| `url` | every kind | The website path a tap opens, naming the item: `/assignments?taskId=<id>&taskKind=calendar\|manual` for a deadline (the Assignments page opens that task), `/dining?hall=<hall id>&meal=<meal>` for a dish alert (the hall id is the snapshot's slug, such as `tower-dining`, which the app compares exactly), `/settings` for the test push. The app maps each path to its own screen. |
| `itemId`, `itemKind` | deadline reminders | The task: its id, and `calendar` (a feed item) or `manual` (a task the student added). The app reads `calendar` as its `imported`. |
| `subtitle` | dish alerts | The hall and meals, "Tower Dining · lunch and dinner". Web notifications have no subtitle, so the service worker shows it as the first line of the body. |
| `expiresAt` | deadline reminders, dish alerts | When the news stops being true: the due moment, or the end of the last meal that serves a starred dish. It sets how long Expo keeps a phone's undelivered copy; the service worker ignores it, and Web Push still keeps a message for 24 hours. |

The test push says what the device it reaches gets (item 2). A phone with
local reminders on gets "Notifications are on for this iPhone" ("this phone"
on Android) and "Favorite dish alerts come here. Class and task reminders come
from the phone itself."; browsers and every other phone keep "BoilerIndy
notifications are on" and "You will get deadline reminders on this device."
It opens `/settings`, with `kind: "test"`.

## Kind registry

Issue #550 (item 10) turns BoilerIndy's notifications into kinds, each with
its own loudness, grouping, lifetime and quiet-hours rule.
`src/notificationKinds.mjs` lists every kind, the phone's and the server's,
and is the one place both sides read them from: this server imports it, and
the native app keeps a generated copy (`src/lib/notification-kinds.json` in
boilerindy-app, written by its sync script from this file on
`origin/develop`). The module imports nothing and reads no environment
variable, so it can be copied on its own and bundled for a browser, which
`test/notificationKinds.test.mjs` checks.

| Kind | Sent by | iOS level | Thread | Relevance | Android channel | Sound | Quiet hours | Kept for | Daily cap | Tap |
|---|---|---|---|---|---|---|---|---|---|---|
| `class` | the phone | time-sensitive | class | | `classes` | yes | ignores | | no | `/events/[id]` |
| `deadline` | the phone; this server for browsers and older builds | active | deadline | 0.7 | `deadlines` | yes | moved to the end, or dropped; merged within 30 min | until due | yes | `/assignments?taskId&taskKind` |
| `deadline-digest` | the same | active | deadline | 0.8 | `deadlines` | yes | never inside | until the first item is due | yes, folds into the next | `/assignments` |
| `dining-favorites` | this server | passive | dining | 0.3 | `dining` | no | never inside | until the meal ends | yes, 1 a day | `/dining?hall&meal` |
| `campus-alert` | this server, to every device that allows it | time-sensitive | safety | 1 | `safety` | yes | ignores | 30 min | no | `/safety?incident` |
| `campus-all-clear` | the same | active | safety | 0.6 | `safety` | yes | goes silent | 2 h | no | `/safety?incident` |
| `runout` | the phone | passive | notices | | `local-reminder-notices` | no | moved to the end | | no | opens the app |
| `test` | this server | active | account | 0.2 | `general` | yes | ignores | 1 h | no | `/settings` |
| `bus-alert` (later) | this server | time-sensitive | transit | 0.9 | `transit` | yes | ignores | until the bus is due | its own | `/transit?stop` |
| `room-change` (later) | this server | active | class | 0.9 | `classes` | yes | moved to the end; dropped at the start | until the class starts | yes | `/schedule?item&at` |
| `bus-live-activity` | this server, over APNs | Lock Screen and Dynamic Island | | | iOS only | at Arriving | ignores | 60 s an update; 30 min in all | no | `boilerindyapp://map?view=transit&stop` |

A tap on what the server sends goes to the website path its `url` carries,
which the app maps to a screen; a local notification carries the app route.
The actions, each of which opens the app: Directions on classes and room
changes, Mark done on deadlines, See the menu on dish alerts, Track on bus
alerts. The Live Activity's End button is its own. The registry also holds
the Android channels (name, importance, and lock screen visibility: classes
and deadlines are private), the action categories, each kind's default
(classes off, 15 minutes before; deadlines as a 6:00 PM list with "1 hour
before each" off; dish alerts off; campus alerts on where notifications are
already allowed) and where the app offers it, and the account defaults that
are not one kind's: quiet hours from 11:00 PM to 8:00 AM campus time, and at
most 6 server pushes to a student a day.

What reads it today:

- `buildExpoMessages` (`src/expoPush.mjs`) sets each message's fields by
  kind ([Native devices (Expo)](#native-devices-expo)). Only a kind the
  server pushes goes out (`serverPushKind`): a kind only the phone sends, a
  later kind, the Live Activity or an unknown name throws, and so does a kind
  kept until something happens whose payload has no `expiresAt`.
- `GET /api/push/config` reports `kinds: { version, digest }`.
- `PUSH_KINDS_OFF` ([below](#stopping-a-kind-push_kinds_off)).
- `src/pushPolicy.mjs`, the policy core: the daily cap and the kinds it
  counts, the 30-minute merge, the default quiet hours and evening list, all
  from the registry ([Choices by kind](#choices-by-kind-the-evening-list-quiet-hours-and-the-daily-cap)).
- `src/liveActivities.mjs`: the Live Activity's 30-minute life and the 60
  seconds an update is kept ([Track this bus](#track-this-bus-the-live-activity)).

The rest of issue #550 builds on it: campus alert pushes (item 9) are in [The
fast tick](#the-fast-tick-campus-alerts), and the Live Activity's
sender in [Track this bus](#track-this-bus-the-live-activity). The copy and the links to the item
(items 2 and 5) are in [Notification payload](#notification-payload), the
choices by kind (items 3 and 8) and the dish alerts' timing (item 6) below,
and what a phone takes and the receipts (items 4 and 7) under [Native devices
(Expo)](#native-devices-expo). Browsers get the same payload and tag as
phones.

### Version and digest

`NOTIFICATION_KINDS` is everything a copy has to agree on. Its digest is the
SHA-256, in lowercase hex, of its canonical JSON: the keys of every object
sorted by UTF-16 code unit, arrays in order, no whitespace (`canonicalJson`).
In Node:

```js
import { createHash } from 'node:crypto'
import { NOTIFICATION_KINDS, canonicalJson } from './src/notificationKinds.mjs'

createHash('sha256').update(canonicalJson(NOTIFICATION_KINDS)).digest('hex')
```

`notificationKindsDigest()` takes the same digest with Web Crypto. Any change
to the registry, even one field of one kind, bumps
`NOTIFICATION_KINDS_VERSION`: `test/notificationKinds.test.mjs` pins the
digest of every version and fails on a change without a bump, printing the
pair to add. `GET /api/push/config` reports both, so once the app has its
copy, drift shows in three places: the app's test recomputes its copy's
digest, its `scripts/api-smoke.mjs` compares it with production's, and the
test here catches a change made without a new version.

### Test vectors

`vectors` holds the cases both repos' quiet-hours and digest code must pass,
on the two days of 2027 the campus clocks change: the night into 2027-03-14
(11:00 PM EST to 8:00 AM EDT, 8 hours) and the night into 2027-11-07 (11:00
PM EDT to 8:00 AM EST, 10 hours), and the 6:00 PM digest around both, each
listing what is due until the next day's (23 and 25 hours on the days of the
change). Quiet hours and digest times are campus wall-clock minutes, never
"now plus N hours"; the first minute of quiet hours is inside them and the
minute they end is not. The test checks every vector against `zonedTimeMs`
(`src/campusTime.mjs`).

### Stopping a kind: PUSH_KINDS_OFF

`PUSH_KINDS_OFF` lists kind ids, separated by commas or spaces, that the
server stops sending, with no code change. A stopped kind is skipped before
anything is read or claimed, so an item still in its window gets its reminder
once the kind is back on:

- `deadline`: the reminders before each item stop, and the phones that
  schedule their own reminders carry on. `deadline-digest` stops the evening
  lists. With both, the reminder run answers `{ ok: false, reason:
  "kind_off" }` before reading anything.
- `dining-favorites`: the dish alert run answers `reason: "kind_off"`.
- `test`: `POST /api/push/test` answers 503 `push_kind_off`.

Words that name no kind this server sends (a typo, or `class` and `runout`,
which only the phone sends) are ignored, and the boot log names them; it also
lists the kinds that are off.

## Which items get a reminder

- `calendar_items` in the categories `assignment`, `quiz`, `exam`, `project`
  and `deadline`, unless the student marked them done (`user_task_completions`).
- `user_manual_tasks` that are not completed.
- Due within `(now - 5 min, now + leadMinutes]`. Date-only feed items
  (`all_day`) count as due at 23:59 campus time on their date, matching the
  "due by end of day" wording in the app.
- Exactly once per item: the runner inserts `(user_id, item_key)` into
  `push_deliveries` before sending. A failed send is not retried in v1.

A run handles at most 200 users and 300 sends; the cron comes back 5 minutes
later for the rest. Subscriptions that a push service reports gone (404 or 410)
are deleted on the spot; other failures increment `failure_count`.

That is the whole rule until README step 53 runs. After it, the choices by
kind decide what goes and when (below).

## Choices by kind, the evening list, quiet hours and the daily cap

Issue #550, items 3 and 8. `db/supabase-push-kinds.sql` (README step 53) adds
the choices by kind to `push_settings`, one row per account, so the website's
card and the app show the same kinds:

| Column | Setting | Default | Means |
|---|---|---|---|
| `deadline_reminders` | `deadlineReminders` | on | Deadlines at all: the evening list and the reminders. Older app builds still drive it. |
| `digest_minute` | `digestMinute` | 1080 (6:00 PM) | The evening list's time, campus minutes past midnight; null for none. |
| `deadline_items`, `lead_minutes` | `deadlineItems`, `leadMinutes` | off, 60 | A reminder before each item, `leadMinutes` ahead. |
| `quiet_start`, `quiet_end` | `quietStart`, `quietEnd` | 1380 to 480 (11:00 PM to 8:00 AM) | Quiet hours; a null pair for none. |
| `class_reminders`, `class_lead_minutes` | `classReminders`, `classLeadMinutes` | off, 15 | The app's class reminders, which the phone schedules. The website only shows them. |
| `campus_alerts` | `campusAlerts` | on | Campus alert pushes and their all clears ([The fast tick](#the-fast-tick-campus-alerts)). Before step 53 every account gets them. |
| `kinds_migrated_at` | `kindsMigrated` | not set | When the first phone on an app build with kinds filled the account in from its old switches. |

Existing rows keep their per-item reminders (`deadline_items` takes
`deadline_reminders`) and gain the 6:00 PM list and quiet hours (owner
decision 2); a new account starts with the list and no per-item reminders.
Until step 53 runs, `GET /api/push/settings` answers `kindsAvailable: false`
with the settings that step will give the account, a `PUT` of a choice by
kind answers 503 `push_kinds_schema_missing`, the Settings card shows only
what it showed before, and the reminder run sends a reminder before every
item, as it did.

What the reminder run then does for each student with deadlines on, on the
campus clock (`src/pushPolicy.mjs`, with the shared vectors of the [kind
registry](#test-vectors)):

- **The evening list:** once the day's `digestMinute` has come, one push
  naming what is not done and due before the next day's list ("3 due
  tonight" / "By 11:59 PM" / "HW 3, Quiz 4 and Lab 2 report."; when
  something on it is due tomorrow, "2 due by tomorrow at 10:00 AM" and "First
  due at 11:59 PM"). Claimed as `deadline-digest:<YYYY-MM-DD>`, so it goes
  once a day, and kept on a phone until its first item is due. It never goes
  inside quiet hours (a time inside them is refused when saved, and a run
  that falls inside them skips that day's list) and nothing goes when
  nothing is due.
- **The reminder before each item**, with `deadlineItems` on: `leadMinutes`
  ahead, an all-day item at 9:00 AM on its day rather than an hour before
  11:59 PM. A reminder whose time has come takes along the items due within
  30 minutes after its own, so three items due at 11:59 PM make one push ("3
  due in 1 h" / "HW 3, Quiz 4 and Lab 2 report are due by 11:59 PM."). Each
  item is claimed as before; the extra items of a merged push are claimed as
  `deadline-merged`. Inside quiet hours nothing is claimed: a reminder goes
  when they end, or never once its item is due by then.
- **The daily cap:** at most 6 server pushes a student a campus day across
  the capped kinds (the evening list, reminders, dish alerts), counted from
  today's claims in `push_deliveries` (a merged push counts once). Past it,
  nothing more is claimed until campus midnight; an evening list past it is
  skipped that day.

The dish alerts follow the same quiet hours and cap. The summary each run
logs counts `digests`, `held` (waiting out quiet hours) and `capped`.

## Favorite dish alerts (issue #469)

An opt-in second kind of push, off by default: at most one a day naming the
student's favorite dishes (the stars on the Dining page) on that day's menu.

- The switch is `push_settings.dining_favorite_alerts`, added by
  `db/supabase-dining-favorite-alerts.sql` (README step 42). Until it runs the
  Settings card shows the switch disabled ("Not available yet"), `GET
  /api/push/settings` answers `diningAlertsAvailable: false`, turning it on
  answers 503 `dining_alerts_schema_missing`, and the run skips the alerts.
- No new cron job: the reminder tick runs `runDiningFavoriteAlerts`
  (`src/diningFavoriteAlerts.mjs`) after the deadline reminders, and the
  summary carries its counts under `dining`.
- It sends from 8:00 AM to 7:00 PM campus time, once the day's menu is firm.
  For each opted-in student it matches their favorites (normalized names)
  against today's dining snapshot, every meal, and claims
  `dining-favorites:<YYYY-MM-DD>` in `push_deliveries` before sending, so
  overlapping runs send once. A student with no favorite on the menu is not
  claimed, and the next tick checks again.
- It goes 30 minutes before the first meal that serves one of the student's
  starred dishes (issue #550, item 6): 10:00 AM for lunch or brunch, 4:00 PM
  for dinner, 8:00 AM for breakfast or a meal the windows in
  `src/diningMeals.mjs` do not name. Until then the student is left
  unclaimed and counted as `early` in the summary, so a student who stars
  only dinner dishes hears about them at 4:00 PM, not at 8:00 AM.
- The payload leads with the news (issue #550, item 2): `{ "title": "Veggie
  Burger is on today", "subtitle": "Tower Dining · lunch and dinner", "body":
  "Also on today: Beef Stroganoff and Smash Burger (Campus Center). Lunch is
  served until 4:30 PM.", "url": "/dining?hall=tower-dining&meal=lunch",
  "tag": "dining-favorites-<YYYY-MM-DD>", "kind": "dining-favorites",
  "expiresAt": "<the end of the last meal that serves one of the dishes>" }`.
  The title names the first starred dish on the menu, the subtitle its hall
  and meals, and the body the others (three named at most, then "and N
  more", each with its hall when it is another one) and when the first dish's
  first meal ends, read from the hall's listed hours and the meal windows as
  the app's Dining widget reads them (`buildDiningToday`); a last meal on a
  day with no listed hours has no known end, so the body leaves it out. A tap
  opens that hall and meal. It goes to every browser and phone the student
  has, phones with local reminders included, through the same delivery path
  as the reminders. On a phone it is passive: no sound, in its own stack
  ([Kind registry](#kind-registry)). `expiresAt` follows the meal windows in
  `src/diningMeals.mjs`: breakfast ends at 10:30 AM, brunch and lunch at 4:30
  PM, dinner and anything else at midnight.

## Native devices (Expo)

The native app (`boilerindy-app`) cannot hold a Web Push subscription. It asks
`expo-notifications` for an Expo push token (`ExponentPushToken[...]`) and
registers that instead (issue #194); the server sends through Expo's push
service, which hands the message to APNs or FCM with the credentials stored in
EAS.

1. The app posts `{ token, platform, deviceName?, localReminders? }` to
   `POST /api/me/push-token`. `platform` is `ios` or `android`, the token must
   match `ExponentPushToken[...]` or `ExpoPushToken[...]`, `deviceName` is cut
   to 120 characters, and `localReminders` is a boolean, false when left out
   ([below](#phones-with-local-reminders)). The row lands in `push_devices`
   (`db/supabase-push-devices.sql`, README step 40), upserted by token:
   registering again refreshes `last_seen_at`, clears the strikes and replaces
   `localReminders`, and a phone that signs in to another account moves to
   that student. At most 10 phones per student, refused with the same 409 as
   the browser cap.
2. The same call makes sure the student has a `push_settings` row, inserting
   the defaults (reminders on, 60 minutes ahead) when there is none and never
   overwriting a saved choice: the reminder runner reads only students who
   have a row. The switch and the lead time are shared with the website.
3. Each push goes to every browser the student has and to the phones that
   take its kind ([What a phone takes](#what-a-phone-takes-kinds-and-channels));
   test sends go to all of them. `push_deliveries` still claims each item once
   per student before anything is sent. `src/expoPush.mjs` posts the messages
   to `https://exp.host/--/api/v2/push/send`, at most 100 per request with an
   8 s deadline, and reads one ticket per message back.
4. `DELETE /api/me/push-token` with `{ token }` removes the phone, for the app
   to call when the student signs out or turns notifications off.

A message carries the title and body the browsers get (clipped to 120 and 500
characters, since Expo refuses a notification over 4 KiB and a calendar feed
title has no limit), `data: { url, kind, tag }` (plus `itemId` and `itemKind`
on a deadline reminder, for the app's Mark done action) for the app to open the right
screen on a tap, the payload tag as `collapseId` and `tag`, so a phone that
was offline shows only the latest message per item, and the fields its kind
sets in the [kind registry](#kind-registry) (issue #550, item 1):

| Kind | `interruptionLevel` | `threadId` | `relevanceScore` | `categoryId` | `sound` | `priority` | `ttl` |
|---|---|---|---|---|---|---|---|
| `deadline` | `active` | `deadline` | 0.7 | `deadline` | `default` | `high` | until the item is due |
| `dining-favorites` | `passive` | `dining` | 0.3 | `dining` | none | `normal` | until the last meal that serves a starred dish ends |
| `test` | `active` | `account` | 0.2 | none | `default` | `high` | 1 hour |

A passive kind plays no sound and goes at normal priority, which iOS may hold
and deliver in a batch (APNs priority 5); the rest go at high priority. The
`ttl` ends when the news stops being true, where every message used to be
kept for 24 hours, and a reminder already due goes with `ttl: 0` (now or
never). A payload's `subtitle`, when a kind has one, goes too (clipped to 120
characters). `channelId`, the kind's Android channel, goes only to a phone
that reported creating it ([below](#what-a-phone-takes-kinds-and-channels)):
without one Expo uses a default Android channel it creates itself, while a
named channel the app has not created hides the notification.

What Expo answers, and what happens to the row:

| Ticket | Row |
|---|---|
| `ok` | Strikes cleared. Expo accepted the message, which is not yet delivery (see receipts below). |
| `DeviceNotRegistered` | Deleted at once: the app was uninstalled or its token rotated. |
| `InvalidCredentials`, `MismatchSenderId` | Unchanged. The APNs or FCM credentials in EAS are wrong, so every phone fails the same way, and counting it against the phones would delete them all. |
| `MessageTooBig` | Unchanged: the payload is ours, not the phone's. |
| Any other error | One strike (`failure_count + 1`). A phone with five strikes is skipped, and the next reminder run deletes the row. |
| No ticket (a timeout, a network failure, a 4xx or 5xx for the whole request) | Unchanged: an Expo outage says nothing about the phones. The messages count as failed, the reason is logged, and they are not retried. |

Log lines name the error code only. An Expo push token is a capability
(anyone holding one can notify that phone through Expo), so tokens are never
logged or returned, and the ticket messages, which quote the token, are
dropped.

Receipts (issue #550, item 7, README step 55). A ticket only says Expo
accepted the message; APNs or FCM can still refuse it, and Expo reports that
in a receipt (`POST https://exp.host/--/api/v2/push/getReceipts`, best read
about 15 minutes after the send and kept for 24 hours). Each ticket Expo
answers is kept in `push_tickets` with its phone and kind, and every reminder
tick, after the sends, `runPushReceipts` (`src/pushReceipts.mjs`) reads the
receipts of tickets older than 15 minutes, at most 1,000 a run, and records
each in `receipt`:

| Receipt | What happens |
|---|---|
| `ok` | Recorded. APNs or FCM took the message. |
| `DeviceNotRegistered` | Recorded, and the phone is deleted (its tickets go with it), so an uninstalled app is dropped within the hour of a send instead of at its next failed send. |
| Any other error | Recorded by its code and counted in the log line, which carries codes and counts only. No strike. |
| None after 24 hours | Marked `expired`: Expo no longer has it. |
| None yet | Left for the next tick. |

When Expo does not answer, nothing is marked and the next tick tries again.
The retention job (README step 51) deletes tickets after 2 days. Before step
55 the table is missing: tickets are not kept, receipts are not read, and the
log names the file once. The summary of each tick carries the run under
`receipts`.

Expo access tokens (issue #550, owner decision 7). With "enhanced push
security" on for the project in the EAS dashboard, Expo refuses every send
that lacks the project's access token. When `EXPO_ACCESS_TOKEN` is set, every
Expo request carries it as `Authorization: Bearer <token>`, from the test send
and the reminder runs alike; nothing logs or returns it. The order matters:
create the token (expo.dev/settings/access-tokens), set `EXPO_ACCESS_TOKEN` on
Render and let it deploy, and only then turn enhanced push security on. The
other way round, every send fails as `http_401 UNAUTHORIZED` (a failed
request, no strikes) until the token arrives.

Owner setup, once:

1. APNs key and FCM credentials for the app in EAS (`eas credentials`).
2. Run `db/supabase-push-devices.sql` after `db/supabase-push.sql` (README step 40).
3. Keep the VAPID keys set: they stay the master switch, so without them
   `POST /api/me/push-token` answers `503 push_disabled` and phones get
   nothing either.
4. On a physical phone, turn notifications on in the app. Then, signed in as
   the same student on the website with notifications on for that browser
   (the test button needs it), press "Send a test notification": the browser
   and the phone should both get it.
5. Run `db/supabase-push-local-reminders.sql` (README step 47) before an app
   build that sends `localReminders` ships, or its phones get each deadline
   twice ([below](#phones-with-local-reminders)).
6. Run `db/supabase-push-device-kinds.sql` (README step 54) before an app
   build that sends `kinds` ships, and `db/supabase-push-tickets.sql` (step
   55) for the receipts; then re-run step 50, since 55 adds a table, and step
   51 for the tickets' retention job.

### What a phone takes: kinds and channels

Issue #550, item 4, README step 54. An app build with the [kind
registry](#kind-registry) reports more when it registers at
`POST /api/me/push-token`:

| Field | Column | Means |
|---|---|---|
| `kinds` | `kinds` | The server kinds the phone shows, never one it schedules itself (classes, or deadlines while the phone plans them), so no kind reaches it from two senders. Unknown names are dropped. |
| `channels` | `channels` | The Android channels the build created. |
| `kindsVersion` | `kinds_version` | The registry version the build carries. |
| `redact` | `redact` | The app lock is on: the copy is to show times and counts only (plan step 11). |
| `activityStartToken` | `activity_start_token` | The Live Activity push-to-start token, kept for later. Never returned or logged. |

Every registration replaces them, so a body from an older build stores no
`kinds`. A phone with `kinds` then gets a server push only of a kind it
listed, a kind whose registry default follows one it listed (the campus all
clear follows the alert), and the test push, which a student sends to check
every device (`deviceTakes` in `src/pushReminders.mjs`); a message names its kind's
Android channel only when the phone listed it. A phone with no `kinds` is an
older build and keeps the rule of [Phones with local
reminders](#phones-with-local-reminders). The answer echoes `kinds`,
`channels`, `kindsVersion` and `redact`, and `GET /api/push/settings` lists
each phone's `kinds`. Until step 54 runs, phones register without these
facts, the log names the file once, and every phone counts as an older build.

### Phones with local reminders

The app schedules the student's class and task reminders on the phone itself
(local notifications, off by default, per account and device). A phone also
needs to register for push to get what it cannot know ahead of time: the
favorite-dish alerts now, club or "leave now" alerts later. Once registered,
it would get every deadline reminder twice, once from the phone and once from
the reminder run. The owner's choice on 2026-10-24
(Antoniodeoliveirasegura/boilerindy-app#55, option a): such a phone gets no
deadline reminders from the server, and every remote-only alert still reaches
it. Browsers are unchanged.

- The app sends `localReminders: true` in the `POST /api/me/push-token` body
  while local reminders are on for that student on that phone, and `false`
  when they are off. Every registration replaces the stored flag, and a body
  without it stores `false`, so the app sends it on every registration
  (launch, a new token, an account switch), not only when the switch changes.
  Anything but `true` or `false` answers 400 with
  `localReminders must be true or false.`, before anything is stored.
- The answer says what the server stored, `201 { device: { id, createdAt,
  localReminders } }`, and `GET /api/push/settings` lists `localReminders` for
  each phone.
- The reminder run (`runDeadlineReminders`) leaves a phone with the flag out
  of the deadline reminders. The student's browsers and other phones still
  get them, each item claimed once in `push_deliveries` as before. A student
  whose only devices are phones with the flag is skipped and nothing is
  claimed, so an item still gets its reminder if local reminders are turned
  off, and the phone registers again, while the item is in its window.
- The favorite-dish alerts and the Settings test send ignore the flag and
  reach every phone. The test send says so on such a phone: "Favorite dish
  alerts come here. Class and task reminders come from the phone itself."
- The column is `push_devices.local_reminders`, added by
  `db/supabase-push-local-reminders.sql` (README step 47), false by default.
  Until it runs nothing breaks: a phone registers without the flag and the
  answer says `localReminders: false`, the server log names the file once per
  process (`[push_local_reminders] schema missing: run
  db/supabase-push-local-reminders.sql ...`), the settings list every phone
  with `localReminders: false`, and the reminder run sends deadline reminders
  to every phone, as before. Every read and write of the column goes through
  `withLocalRemindersColumn` in `src/pushReminders.mjs`, which retries without
  it.

## The fast tick: campus alerts

Issue #550, item 9 (issue #34). The pg_cron job in
`db/supabase-push-fast-tick.sql` (README step 57, production only) calls
`POST /api/internal/push/fast-tick` every minute (every 30 seconds until
2026-11-03, see [database-outage.md](database-outage.md)) with the same bearer
token as the reminder run. The tick reads IU's alert for the Indianapolis
campus through the banner's cache, so IU is never asked more often than
before, and `src/campusAlertPush.mjs` pushes:

- an incident's first message, as `campus-alert` (time-sensitive; it ignores
  quiet hours and the daily cap), to every phone that takes the kind and every
  browser, of each account whose `campus_alerts` is on (every account before
  step 53);
- IU's "Campus Status Normal" that closes it, as `campus-all-clear`, under the
  alert's tag `campus-<incident>`, so it replaces the alert; in a student's
  quiet hours it is silent (`passive`, no sound, Web Push urgency `low`);
- IU's tests to admins only (`users.is_admin` or `ADMIN_EMAILS`).

Updates and finals only change the banner, and a message first seen more than
30 minutes after IU sent it is not pushed. Each push is claimed on its
incident (`alert_pushed_at`, `clear_pushed_at`, README step 56) before it is
sent, and a tick that comes while the last one is still sending is skipped,
so nothing goes twice. An Expo request that got no tickets back is sent once
more after 2 seconds. Without VAPID keys, with `CAMPUS_ALERT_PUSH` or
`CAMPUS_ALERTS` off, or with `campus-alert` in `PUSH_KINDS_OFF`, nothing is
pushed. The rules, the incidents and the operations are in
[campus-alerts.md](campus-alerts.md#push-notifications). After the campus
alerts, the same tick runs the Live Activities ([Track this
bus](#track-this-bus-the-live-activity)); each half has its own retry, so a
failure in one leaves the other its turn.

## Track this bus: the Live Activity

Issue #550 ("Later"; boilerindy-app#173, item 5). The app shows a bus coming
to a stop as a Live Activity on the Lock Screen and in the Dynamic Island, and
this server keeps it current over APNs (`bus-live-activity` in the [kind
registry](#kind-registry)). The app half, which starts and ends the activity
and draws it, is step 13 of the notifications build; until it ships, nothing
calls these routes.

1. The app sees `liveActivities: true` in `GET /api/push/config`, starts the
   activity from the arrivals it shows, and sends `POST /api/live-activities`
   `{ activityId, token, env, stop, routeId? }`: ActivityKit's id for it, its
   push token in hex, `production` (TestFlight and the App Store) or
   `development` (a build run from Xcode), the place key from
   `GET /api/transit/places`, and the route of the bus (left out, the next
   bus of any route there). Signed in or out (decision 4 of the build): every
   phone is held to the `widget-read` limits on its address, and every
   activity lives 30 minutes at most, the answer's `endsAt`. A new push token
   from ActivityKit goes to `PATCH /api/live-activities/:activityId`, and the
   student ending it to `DELETE`; the activity id, which only the phone knows,
   is what both ask for. `live_activities` (README step 58) keeps one row per
   activity, `user_id` empty when signed out.
2. Every minute the fast tick reads each open activity's stop through the
   widgets' 15-second arrivals cache, once per stop, so TransLoc is never asked
   more often than before, and `src/liveActivities.mjs` sends:
   - the first reading after a start, so the phone and the server agree from
     then on;
   - then an update only when the bus's due time moves by a minute or more,
     and at most once a minute, at priority 5. The phone counts down to the
     time it was sent by itself, so the passing minutes need no push;
   - "Arriving" once the bus is due within a minute, at priority 10 with an
     alert ("Route 5 Purple is arriving", "At Riverwalk Apartments") and the
     default sound, once;
   - every update with `stale-date` 3 minutes ahead, so the activity dims if
     the updates stop;
   - an `end`, with `dismissal-date` 2 minutes ahead, once the bus has come
     (after Arriving it is no longer due, or a bus due within two minutes is
     gone), after the 30 minutes, at the end of service (no bus coming and the
     route past its hours in `src/transitHours.mjs`; a last bus still coming
     keeps it going), or when its stop is gone from TransLoc.

   It follows one bus: the soonest on its route, then that vehicle while
   TransLoc names it, so a second bus on the route does not take over. If that
   bus disappears while still minutes away, the next one takes its place. It
   ends without a push when the student ends it, or when APNs answers that the
   token is gone (410, or a 400 `BadDeviceToken`).
3. `src/apnsLiveActivity.mjs` sends each push to
   `https://api.push.apple.com/3/device/<token>` (`api.sandbox.push.apple.com`
   for `development`) with `apns-push-type: liveactivity`, `apns-topic:
   com.boilerindy.app.push-type.liveactivity`, the priority, and
   `apns-expiration` 60 seconds ahead for an update (the registry's TTL) or an
   hour for an end. One HTTP/2 session per host (`node:http2`) is kept between
   ticks. Token auth: an ES256 JWT naming the key and the team, signed with
   `node:crypto` by the `.p8` key and renewed every 50 minutes, since APNs
   refuses one older than an hour or renewed more often than every 20 minutes;
   a 403 `ExpiredProviderToken` renews it and sends once more.

The body is `{ "aps": { "timestamp", "event", "content-state",
"stale-date"?, "dismissal-date"?, "alert"? } }`, dates in Unix seconds. The
content state, which the app's ActivityKit `ContentState` decodes:

```json
{ "phase": "due", "arrivesAt": 815497620, "routeNum": "5", "routeName": "Purple", "color": "#7A3E9D" }
```

| Key | What it is |
|---|---|
| `phase` | `due` or `arriving` while it runs; at the end, why it ended: `arrived`, `expired` (the 30 minutes), `no-service` or `stop-gone`. |
| `arrivesAt` | When the bus is due, in seconds since 2001-01-01T00:00:00Z: the number Swift's `Codable` reads as a `Date`, which is how ActivityKit decodes `content-state`. Null at the end. |
| `routeNum`, `routeName`, `color` | The route of the bus it shows, from the arrivals read; null when unknown. |

When something goes wrong:

- Each push is claimed before it is sent by changing `last_state` from the
  value the tick read (and setting `ended_at` for an end), so overlapping
  ticks or a second instance never send twice.
- APNs busy or down (429, a 5xx, a timeout, no connection) or refusing the key
  (403): that push's claim goes back and the tick stops; the next tick sends
  it again, and meanwhile the activity dims at its stale date.
- TransLoc down: the arrivals cache serves its last answer, and one older than
  a minute pushes nothing. The 30 minutes still end the activity.
- Any other refusal of one push (a 400) ends that activity, with APNs' reason
  code in the log.
- The log has one `[push] live activities:` line for a tick that sent, failed
  or ended something: the counts and APNs' reason codes, never a token or an
  activity id. The `.p8` key is never logged; a key that does not load is
  refused at boot with a message that does not quote it.

Track this bus runs only with `APNS_KEY_P8`, `APNS_KEY_ID` and `APNS_TEAM_ID`
set, the VAPID keys loaded (they gate every push), and `bus-live-activity` not
in `PUSH_KINDS_OFF`; the config's `liveActivities` says so. Off, `POST` and
`PATCH` answer 503 `live_activity_disabled`, `DELETE` still ends an activity,
and the tick reads nothing for it.

Owner setup, once this server is released (nothing calls the routes until the
app half ships, so the order is free):

1. Run `db/supabase-live-activities.sql` (README step 58), then re-run step 50,
   and step 51 for the retention job that deletes each row a day after its 30
   minutes.
2. In the Apple Developer portal, under Keys, create a key with Apple Push
   Notifications service (APNs) enabled and download its `.p8` file (it
   downloads once). Note its Key ID and the Team ID.
3. Set `APNS_KEY_P8` (the file's contents), `APNS_KEY_ID` and `APNS_TEAM_ID` on
   Render. Until all three load, the boot log says Track this bus is off.
4. Make sure the fast tick's job (README step 57) is scheduled, then track a
   real bus from a TestFlight build: it updates, says Arriving, and ends.

## Platform notes

- iPhone and iPad deliver web push only to apps added to the Home Screen
  (iOS 16.4+). The Settings card detects that case and links to `/install`,
  the public walkthrough for iPhone, Android and desktop. The manifest's
  `start_url` is `/login`, which forwards signed-in users to their dashboard.
- The service worker is registered in production builds only, so the card
  cannot subscribe on `vite dev`; use `vite preview` or the deployed site.
- Reminders fire only when the runner is called while the API is awake. The
  pg_cron request is what wakes Render, so the practical lag is the cron
  interval plus the cold start (see `docs/keep-warm.md`).
- The e2e suite (`e2e/push.spec.js`) exercises the Settings card against the
  mock backend; there is no push service in headless Chromium, so the subscribe
  flow itself is verified by hand.

## Operations

- Pause everything, phones included: unset `VAPID_PUBLIC_KEY` and
  `VAPID_PRIVATE_KEY` and redeploy. Subscriptions and devices stay in their
  tables for when keys return.
- Pause reminders only: `select cron.unschedule('boilerindy-push-reminders');`
  or unset `PUSH_CRON_SECRET`.
- Stop one kind, on every device the server sends it to: add its id to
  `PUSH_KINDS_OFF` on Render ([Stopping a kind](#stopping-a-kind-push_kinds_off)).
- Pause campus alert pushes only, keeping the banners: set
  `CAMPUS_ALERT_PUSH=off` on Render, or
  `select cron.unschedule('boilerindy-push-fast-tick');` (which pauses Track
  this bus too).
- Pause Track this bus only: add `bus-live-activity` to `PUSH_KINDS_OFF`, or
  unset an `APNS_*` variable. Activities already running get no more pushes
  and dim at their stale date; the app stops offering it.
- The ledger prunes itself: `db/supabase-retention.sql` (README step 51,
  issue #528) schedules `boilerindy-retention-push-deliveries`, which deletes
  rows older than 60 days every Sunday. Without it, by hand:
  `DELETE FROM push_deliveries WHERE sent_at < NOW() - INTERVAL '60 days';`
