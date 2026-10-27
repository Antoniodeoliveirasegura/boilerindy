# First-Party Product Analytics (issue #51)

Privacy-conscious usage analytics stored in our own Supabase. **No third-party
trackers** - there is no Google Analytics, no pixel, no external script. Events
power feature prioritization (e.g. consolidating the marketplace issues) and the
accurate data disclosure required for app-store listing (issue #26). The same
posture covers the [sign-up source](#sign-up-source): which marketing link
brought each new account, saved once in `users.signup_ref`.

## How it works

| Piece | Where | What it does |
|---|---|---|
| `db/supabase-analytics.sql` | `db/` | Creates `analytics_events` (RLS, service-role only) and `users.analytics_opt_out`. Run once in the Supabase SQL Editor. |
| `src/analytics.mjs` | `src/` | Pure validation: event-name allowlist, batch cap (20), page/props size caps. Unit-tested in `test/analytics.test.mjs`. |
| `POST /api/usage/events` | src/routes/analytics.mjs | `requireAuth` + rate-limited. Re-checks the opt-out server-side, then inserts the batch with the service-role client. Accepts `text/plain` so `sendBeacon` flushes parse too. Fail-soft (202) if the table is missing. Path is `/usage` (not `/analytics`) so ad blockers don't block it. |
| `boilerindy-react/src/lib/usageStats.ts` | frontend | `track(eventName, props)` queue; flushes every 10s, at 20 queued events, and on `pagehide` via `navigator.sendBeacon`. Disabled (and queue dropped) when signed out or opted out. Named `usageStats` (not `analytics`) so ad-blocker filter lists don't block the module. |
| `boilerindy-react/src/components/UsageListener.tsx` | frontend | Enables tracking only for signed-in, non-opted-out users; records `page_view` on every route change. |
| Settings → Privacy | frontend | Opt-out toggle (writes `analyticsOptOut` via `PATCH /api/me/profile`) + link to `/privacy`. |

## Event allowlist

Only these names are accepted (`ANALYTICS_EVENTS` in `analytics.mjs`); anything
else is rejected with a 400. Add new events to the constant **and** this table.
One unknown name rejects the whole batch, and the client has already taken the
batch off its queue, so `test/analytics.test.mjs` fails CI when a `track()` call
in `boilerindy-react/src/` names an event the constant lacks (#421).

| Event | Fired when |
|---|---|
| `page_view` | Any route change (path in props) |
| `source_synced` | A calendar source is connected or re-synced |
| `board_post_created` | A board post is published |
| `assistant_message_sent` | A campus-assistant message is sent (event only - never the text) |
| `dining_viewed` | Dining page opened |
| `transit_viewed` | Transit page opened |
| `task_completed` | A task is marked complete |
| `deal_viewed` | Perks page opened |
| `deal_clicked` | A deal's address link (to Google Maps) on the Perks page, or the featured-perk banner on Home, is clicked (`page` tells the two apart) |
| `guide_viewed` | Guide page opened |
| `marketplace_viewed` | Marketplace page opened |
| `friends_viewed` | Friends page opened |
| `study_groups_viewed` | Study groups page opened |
| `share_clicked` | A Share button on Transit, Dining or Free Food is pressed, before the share sheet opens or the link is copied (`page` prop: `transit`, `dining` or `free-food`, plus `kind: event` when one free-food event is shared rather than the list; never the link or the event). See [share-links.md](share-links.md) |

## Privacy guarantees

- Signed-in users only; `user_id` references `users(id)` **ON DELETE CASCADE**,
  so deleting an account deletes its analytics rows.
- Opt-out (Settings → Privacy) takes effect immediately: the client drops its
  queue and stops sending, and the server independently refuses to store events
  for opted-out users.
- RLS with no policies: only the service-role key (the Node server) can touch
  the table; the browser's anon key sees nothing.
- No free-form content is ever recorded - no message text, post bodies,
  schedule contents, grades, or location.

## Retention: 12 months

Raw events are deleted after 12 months, which the Privacy page promises.
`db/supabase-retention.sql` (README "Database setup" step 51, issue #528)
schedules the `boilerindy-retention-analytics` `pg_cron` job that runs the
delete every day at 04:00 UTC, beside the weekly `push_deliveries` and daily
`user_sessions` jobs. Check it:

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'boilerindy-retention-%';
```

If an older hand-made `analytics-retention` job exists, remove it with
`SELECT cron.unschedule('analytics-retention');` so only one runs. Without the
job (a local database, or before step 51 runs), the same delete by hand:

```sql
DELETE FROM analytics_events WHERE created_at < NOW() - INTERVAL '12 months';
```

## Sign-up source

Which marketing link brought each new account, so the owner can count sign-ups
per channel (class group chats, Instagram, the two QR flyer messages, each
student ambassador) without a third-party tracker. One tag per account, in
`users.signup_ref`, saved when the account is created and never changed after.

### Making a link

Add `?ref=<tag>` to any page: `https://www.boilerindy.app/?ref=flyer-a`,
`/dining?ref=gc-cs180`, `/transit?ref=ig-bio`, or straight to the form with
`/login?tab=signup&ref=amb-jane`. A tag is a slug: lowercase letters, digits
and single hyphens, at most 40 characters. Anything else is folded into one
(`Flyer_A` reads `flyer-a`) or cut at 40, and a value with nothing usable left,
or with an `@` in it, is dropped. A link that carries only `?utm_source=` (from
a tool that writes UTM tags) counts under that source; `ref` wins when a link
has both.

| Channel | Tag |
|---|---|
| QR flyer, message A or B | `flyer-a`, `flyer-b` |
| Instagram bio or story | `ig-bio`, `ig-story` |
| A class group chat | `gc-<course>`, for example `gc-cs180` |
| A student ambassador | `amb-<name>`, for example `amb-jane` |
| A Share button: the bus map, the dining menu, free food (the list or one event) | `share-bus`, `share-dining`, `share-free-food`, set by the button ([share-links.md](share-links.md)) |

### How it works

| Piece | Where | What it does |
|---|---|---|
| `src/signupRef.mjs` | shared | The slug rule (`sanitizeSignupRef`) and the parameters it reads (`ref`, then `utm_source`): one copy for the browser and the API. |
| `captureSignupRef` | `boilerindy-react/src/main.tsx`, `lib/signupRef.ts` | Once per page load, before the app renders: a usable tag in the address goes to `sessionStorage` (`boilerindy-signup-ref`). A page without one leaves the held tag alone; another tagged link replaces it. |
| Email sign-up | `lib/authApi.ts` (`registerSupabaseUser`) | Sends `signupRef` with `POST /api/auth/register-supabase`. Drops the tag once the account exists, and keeps it when the sign-up is refused so a retry still carries it. |
| Google sign-in | `context/AuthContext.tsx` (`postSync`) | `sessionStorage` survives the redirect to Google and back, as `postAuthNext` does, so `POST /api/auth/supabase-sync` sends `signupRef`. Dropped after any sync that went through. |
| Saving | `src/routes/auth.mjs` (`saveSignupRef`) | Sanitizes again and, only in the request that inserted the `users` row, runs `update users set signup_ref = <tag> where id = <new id> and signup_ref is null`. A sync for an account that already existed saves nothing, and nothing overwrites a saved tag. Best effort: a failed save never fails the sign-up. |
| `db/supabase-signup-ref.sql` | `db/` | README "Database setup" step 45: the nullable column, with a `CHECK` that holds it to the slug rule. Until it runs, sign-up works as before, no tag is saved, and the server log names the file once. |
| `scripts/signup-refs.mjs` | `scripts/` | Prints sign-ups per tag and per campus week, Monday start (`--since=YYYY-MM-DD`, `--csv` for a spreadsheet). Reads `signup_ref` and `created_at` only: counts, never an email or a name. The counting is `src/signupRefReport.mjs`. |

### What it misses

The tag lives in one browser tab, so a sign-up counts under its link only when
it happens in the tab the link opened. These count as `(none)`:

- a student who closes the tab and signs up later in a new one, or in the app
  installed from `/install` (a Home Screen app has its own storage);
- a link opened in an in-app browser (Instagram, GroupMe) whose student moves
  to Safari or Chrome to sign up, unless the page they carry over still has the
  tag in its address;
- sign-ups in the native app, and every account created before the column.

A short-lived first-party cookie would also catch the first case, at the cost
of a second cookie and a change to the privacy page: an owner decision, not
built.

### Privacy

- First-party only: the tag stays in the tab's `sessionStorage` and our own
  database. No cookie, no third-party script, and it goes nowhere else.
- It names the link, not the student. The slug rule refuses a value with an
  `@`, so an email address cannot be saved as a tag.
- It is a column of the `users` row, so deleting the account deletes it.
- The privacy page discloses it in its "Sign-up links" section.

## HUMAN CHECKPOINT before production

Per issue #51, tracking must not ship to prod until the owner reviews and
approves:

1. The draft privacy page at `/privacy` (`boilerindy-react/src/pages/Privacy.tsx`).
2. The one-line disclosure on the signup form (`boilerindy-react/src/pages/Login.tsx`).

After approval: run `db/supabase-analytics.sql` in production Supabase, deploy,
and update the "Last updated" date on the privacy page.

The [sign-up source](#sign-up-source) is a tracking change too (2026-10-20), so
the same review applies before it ships: the privacy page's "Sign-up links"
section and its "Last updated October 20, 2026" date. After approval, run
`db/supabase-signup-ref.sql` (README "Database setup" step 45) in production.
Sign-up works with or without the column, so that step can come before or
after the deploy; tags are saved from the moment both are in place.
