# Push Notifications

Web Push for deadline reminders (issue #9): the "Push notifications" card on
`/settings`, the `/api/push/*` routes behind it, and a reminder runner that the
Supabase scheduler triggers every 5 minutes. Departure alerts (#44) will reuse
the same delivery path. The native app registers Expo push tokens at
`/api/me/push-token` and gets the same reminders and test sends through
Expo's push service (issue #194): see [Native devices (Expo)](#native-devices-expo).

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
4. The service worker shows the notification; tapping it opens `/assignments`.

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

Rotating the VAPID pair invalidates every subscription; users will need to turn
notifications on again on each device.

## Environment variables

| Variable | Purpose |
|---|---|
| `VAPID_PUBLIC_KEY` | 65-byte P-256 point, base64url. Shipped to browsers. |
| `VAPID_PRIVATE_KEY` | 32-byte scalar, base64url. Secret; signs every push request. |
| `VAPID_SUBJECT` | `mailto:` or `https:` contact for push services. Default `mailto:support@boilerindy.app`. |
| `PUSH_CRON_SECRET` | Bearer token for the reminder runner. Blank means the route falls through to the JSON 404. |

The server validates the pair at boot (length, curve membership, and that the
public key matches the private one) and logs a clear error instead of sending
requests that push services would reject with 403.

## API

All routes except `config` and `run-reminders` require a signed-in session.

| Route | Purpose | Notes |
|---|---|---|
| `GET /api/push/config` | `{ enabled, publicKey }` | Public; `public-read` rate limit. |
| `GET /api/push/settings` | `{ enabled, settings: { deadlineReminders, leadMinutes }, subscriptions: [{ id, createdAt, userAgent, lastUsedAt }], devices: [{ id, platform, deviceName, createdAt, lastSeenAt }] }` | Endpoints and tokens are never returned. `devices` is empty until `db/supabase-push-devices.sql` runs. |
| `PUT /api/push/settings` | Body `{ deadlineReminders?, leadMinutes? }` | `leadMinutes` 5 to 10080. `push-write` limit. Shared by browsers and phones. |
| `POST /api/push/subscriptions` | Body `{ subscription, userAgent }`, returns 201 | Upsert by endpoint; at most 10 devices per user. |
| `DELETE /api/push/subscriptions` | Body `{ endpoint }`, returns `{ removed }` | |
| `POST /api/me/push-token` | Body `{ token, platform, deviceName? }`, returns 201 `{ device: { id, createdAt } }` | The native app. Upsert by token; at most 10 phones per user. `push-write` limit. See [Native devices (Expo)](#native-devices-expo). |
| `DELETE /api/me/push-token` | Body `{ token }`, returns `{ removed }` | Only the student's own phone. `push-write` limit. |
| `POST /api/push/test` | Returns `{ sent, failed, removed }` | Every browser and phone the student registered. `push-test` limit (10 per hour). |
| `POST /api/internal/push/run-reminders` | Returns the run summary | `Authorization: Bearer <PUSH_CRON_SECRET>`. A Supabase 5xx or timeout is retried once after 1.5 s; one that persists answers 503 and the next tick tries again (issue #242). |

Error shape follows the rest of the API: `{ error: { message, status, code? } }`.
`code` is `push_not_configured` (tables missing, 503) or `push_disabled` (no
VAPID keys, 503). On `/api/me/push-token` a missing `push_devices` table is
`push_not_configured` too, with a message that names
`db/supabase-push-devices.sql`.

## Notification payload

The encrypted body is JSON:

```json
{ "title": "Assignment due in 45 min", "body": "HW 3 is due at 10:45 AM.", "url": "/assignments", "tag": "deadline-calendar-<id>", "kind": "deadline" }
```

`tag` doubles as the push `Topic` header, so a device that was offline gets
only the latest message per item. Test notifications use `kind: "test"` and
open `/settings`.

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

## Native devices (Expo)

The native app (`boilerindy-app`) cannot hold a Web Push subscription. It asks
`expo-notifications` for an Expo push token (`ExponentPushToken[...]`) and
registers that instead (issue #194); the server sends through Expo's push
service, which hands the message to APNs or FCM with the credentials stored in
EAS.

1. The app posts `{ token, platform, deviceName? }` to `POST /api/me/push-token`.
   `platform` is `ios` or `android`, the token must match
   `ExponentPushToken[...]` or `ExpoPushToken[...]`, and `deviceName` is cut to
   120 characters. The row lands in `push_devices`
   (`db/supabase-push-devices.sql`, README step 40), upserted by token:
   registering again refreshes `last_seen_at` and clears the strikes, and a
   phone that signs in to another account moves to that student. At most 10
   phones per student, refused with the same 409 as the browser cap.
2. The same call makes sure the student has a `push_settings` row, inserting
   the defaults (reminders on, 60 minutes ahead) when there is none and never
   overwriting a saved choice: the reminder runner reads only students who
   have a row. The switch and the lead time are shared with the website.
3. Reminders and test sends go to every browser and phone the student has.
   `push_deliveries` still claims each item once per student before anything
   is sent. `src/expoPush.mjs` posts the messages to
   `https://exp.host/--/api/v2/push/send`, at most 100 per request with an
   8 s deadline, and reads one ticket per message back.
4. `DELETE /api/me/push-token` with `{ token }` removes the phone, for the app
   to call when the student signs out or turns notifications off.

A message carries the title and body the browsers get (clipped to 120 and 500
characters, since Expo refuses a notification over 4 KiB and a calendar feed
title has no limit), `data: { url, kind, tag }` for the app to open the right
screen on a tap, `sound: "default"`, `priority: "high"`, the same 24 hour
`ttl` as Web Push, and the payload tag as `collapseId` and `tag`, so a phone
that was offline shows only the latest message per item. There is no
`channelId`: without one Expo uses a default Android channel it creates
itself, while a named channel the app has not created hides the notification.

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

Not done yet:

- Receipts. A ticket only says Expo accepted the message; APNs or FCM can
  still refuse it, and Expo reports that in a receipt
  (`POST https://exp.host/--/api/v2/push/getReceipts`, best read about 15
  minutes after the send and kept for 24 hours). Until receipts are polled, a
  phone that APNs or FCM drops is only noticed when a later ticket says
  `DeviceNotRegistered`.
- Expo access tokens. If "enhanced push security" is turned on for the project
  in the EAS dashboard, Expo refuses every send without an
  `Authorization: Bearer` access token (`UNAUTHORIZED`, which reads here as a
  failed request, no strikes). The server sends none, so leave that setting
  off until one is wired in.

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
- Prune the ledger occasionally:
  `DELETE FROM push_deliveries WHERE sent_at < NOW() - INTERVAL '60 days';`
