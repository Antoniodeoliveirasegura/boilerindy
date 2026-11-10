# Schedule import

How a student gets their classes and due dates into BoilerIndy, and why the
production path is a pasted link (issue #120; connection UI in
`boilerindy-react/src/pages/ConnectSchedule.tsx`).

## The two feeds

| Source | Source type | Where the link comes from | Host allowlist |
| --- | --- | --- | --- |
| Class schedule | `purdue_schedule_ical` | Purdue Timetabling (UniTime), Personal Schedule, Export, iCalendar | `purdue.edu` |
| Brightspace calendar | `brightspace_ical` | Brightspace, Calendar, Subscribe | `brightspace.com`, `d2l.com`, `desire2learn.com` |

Both are read-only iCalendar feeds the student already owns. BoilerIndy never
sees a Purdue password or a Duo prompt: the student signs in to Purdue in
their own browser, copies the link, and pastes it.

## Production path: guided paste (option A)

The Connect page shows numbered steps for the selected provider, a link that
opens the provider in a new tab, and a paste box. Before the request is sent,
`src/lib/scheduleSourceUrl.ts` checks the link and shows a hint next to the
box when it is wrong:

- empty box, or text that is not a URL;
- a link from the other provider, or any host outside the allowlist (the
  hint names the expected host);
- the Personal Schedule page itself pasted instead of its export link.

The server remains the real gate: `assertSafeHttpUrl` (SSRF checks, redirect
re-validation) plus `SCHEDULE_SOURCE_HOSTS` in `src/routes/sources.mjs`. The
client list must be kept identical to it. The server checks the allowlist when
a source is added and again on every sync, for the stored link and for each
redirect hop (`safeFetchIcsText` in `src/urlSafety.mjs`), so a redirect cannot
leave the provider, and a link stored before the allowlist was enforced fails
its sync with "That calendar provider is not allowed." instead of being
fetched.

## Import limits

One sync of one feed reads and writes at most this much. A real feed is far
below every limit (a few hundred kilobytes, events and items), and a feed over
one is refused whole: the source is marked `error` with the reason, and the
items an earlier sync stored stay as they were.

| Limit | Where | Message |
| --- | --- | --- |
| 5 MB of feed body, after gzip or brotli decoding | `MAX_FEED_BYTES`, `src/urlSafety.mjs` | This calendar feed is over 5 MB, too large to import. |
| 5,000 events, counted before parsing | `MAX_FEED_EVENTS`, `src/scheduleSync.mjs` | This calendar has more than 5,000 events, too many to import. |
| 5,000 dated items after recurrences expand | `MAX_FEED_ITEMS`, `src/scheduleSync.mjs` | This calendar repeats into more than 5,000 dated items, too many to import. |

A rule that repeats within a day (`FREQ=HOURLY` or finer, or several `BYHOUR`,
`BYMINUTE` or `BYSECOND` values) imports once, at its start, since the import
keeps one occurrence per event per day anyway. Each stored text keeps the
column limits in `raw_json` too: 500 characters for the title, location and
UID, 5,000 for the description.

Two more links pass both checks: the demo calendars for the App Review account
(issue #521), on BoilerIndy's own origin, which the server builds itself
instead of fetching. See [demo-calendars.md](demo-calendars.md).

This was the recommended option in #120 because it works in production
today, needs no new infrastructure, and keeps Purdue credentials entirely on
the student's side. Option B (a browser extension or bookmarklet that grabs
the export link) stays open as a later convenience; C (server-driven login)
was rejected; D (CAS) yields identity only, not the feed.

## Dev-only auto-capture

`src/purdueCalendarAutomation.mjs` can open a local, headed Chromium, let the
developer sign in, and scrape the export link. It is gated behind
`PURDUE_CALENDAR_AUTOMATION=1` and answers a JSON 404 in production, where it
cannot work (no display, and it would not be the remote student's browser
anyway). `playwright` is a devDependency for that script, the icon renderer
and the e2e suite; production installs never need it.

## Open question

UniTime's export link carries an encrypted query (`x=...`). Whether it
expires, and what happens on the next sync when it does, is still unverified.
The sync marks a source `error` with a "feed URL may have expired" message on
a 401/403, so a student would see it on the Connect page and paste a fresh
link, but a longer-lived answer needs a real link watched over a term.
