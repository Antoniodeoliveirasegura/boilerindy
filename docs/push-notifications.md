# Push Notifications

Web Push for deadline reminders (issue #9): the "Push notifications" card on
`/settings`, the `/api/push/*` routes behind it, and a reminder runner that the
Supabase scheduler triggers every 5 minutes. Departure alerts (#44) will reuse
the same delivery path.

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
| `GET /api/push/settings` | `{ enabled, settings: { deadlineReminders, leadMinutes }, subscriptions: [{ id, createdAt, userAgent, lastUsedAt }] }` | Endpoints are never returned. |
| `PUT /api/push/settings` | Body `{ deadlineReminders?, leadMinutes? }` | `leadMinutes` 5 to 10080. `push-write` limit. |
| `POST /api/push/subscriptions` | Body `{ subscription, userAgent }`, returns 201 | Upsert by endpoint; at most 10 devices per user. |
| `DELETE /api/push/subscriptions` | Body `{ endpoint }`, returns `{ removed }` | |
| `POST /api/push/test` | Returns `{ sent, failed, removed }` | `push-test` limit (10 per hour). |
| `POST /api/internal/push/run-reminders` | Returns the run summary | `Authorization: Bearer <PUSH_CRON_SECRET>`. |

Error shape follows the rest of the API: `{ error: { message, status, code? } }`.
`code` is `push_not_configured` (tables missing, 503) or `push_disabled` (no
VAPID keys, 503).

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

## Platform notes

- iPhone and iPad deliver web push only to apps added to the Home Screen
  (iOS 16.4+). The Settings card detects that case and explains the steps.
- The service worker is registered in production builds only, so the card
  cannot subscribe on `vite dev`; use `vite preview` or the deployed site.
- Reminders fire only when the runner is called while the API is awake. The
  pg_cron request is what wakes Render, so the practical lag is the cron
  interval plus the cold start (see `docs/keep-warm.md`).
- The e2e suite (`e2e/push.spec.js`) exercises the Settings card against the
  mock backend; there is no push service in headless Chromium, so the subscribe
  flow itself is verified by hand.

## Operations

- Pause everything: unset `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` and
  redeploy. Subscriptions stay in the table for when keys return.
- Pause reminders only: `select cron.unschedule('boilerindy-push-reminders');`
  or unset `PUSH_CRON_SECRET`.
- Prune the ledger occasionally:
  `DELETE FROM push_deliveries WHERE sent_at < NOW() - INTERVAL '60 days';`
