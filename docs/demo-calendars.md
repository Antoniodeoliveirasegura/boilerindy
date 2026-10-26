# Demo calendars

The demo account that Apple's reviewers sign in with (Beta App Review for
TestFlight now, App Review later) needs classes and coursework, or Home,
Schedule and Tasks open empty. Two made-up calendars give it both, a Purdue
Timetabling class schedule and a Brightspace calendar (issue #521). The server
builds them itself and fetches nothing.

## The links

| Calendar | Link |
| --- | --- |
| Purdue timetable | `https://www.boilerindy.app/api/demo/calendars/purdue-timetable.ics` |
| Brightspace | `https://www.boilerindy.app/api/demo/calendars/brightspace.ics` |

A link counts only on one of the server's own origins: `CLIENT_APP_URL`
(`https://www.boilerindy.app` in production) or `BACKEND_PUBLIC_URL`. In local
development that is `http://localhost:5173/api/demo/calendars/...`. The path
has to match exactly, with no query string.

## Adding them to the demo account

Sign in as the demo account, then add both links as you would add any
calendar:

- **App:** Services, Setup. Under the calendars, choose **Purdue timetable**,
  paste the first link into **Calendar subscription URL** and press **Add
  calendar**. Then choose **Brightspace** and add the second link.
- **Website:** `/setup`, **Add Calendar Source**. Pick **Class Schedule**,
  paste the first link and press **Connect Schedule**. Then pick **Brightspace
  Calendar** and **Connect Brightspace** with the second link.

Each add answers with the items it imported. They show as "Schedule" and
"Brightspace Calendar", like a real student's calendars, and Home then has a
next class, the rest of the day, tasks due and the week ahead.

## How it works

- `src/demoCalendars.mjs` writes the two iCalendar files. It is pure: the
  clock comes in as `now`, and two builds on the same Indianapolis day are
  identical.
- `POST /api/sources/purdue/schedule` and `POST /api/sources/brightspace/schedule`
  recognize their own provider's demo link (`matchDemoCalendarUrl`) and store
  it without the host allowlist or the address checks, since nothing will
  fetch it. The other provider's demo link, the demo path on any other host,
  and a demo link with a query string all meet the allowlist as before, and
  are refused.
- Every sync of a demo source builds its text in-process (`feedText` in
  `src/routes/sources.mjs`) instead of calling `safeFetchIcsText`: the Sync
  buttons, the hourly re-sync ([source-resync.md](source-resync.md)) and the
  development-only debug view alike. It goes by the path alone
  (`demoCalendarFileOf`), so a source added under an earlier `CLIENT_APP_URL`
  is still built here; no provider's feed has these paths. The re-sync picks a
  source up every 6 hours, so the demo moves forward with the calendar.
- `GET /api/demo/calendars/:file` answers the same text to anyone, so a link
  also opens in a browser or a calendar app. It is a public read (behind
  `public-read` and `public-read-ip`, see [RATE_LIMITS.md](RATE_LIMITS.md)),
  cached 5 minutes in the browser and an hour at the edge. Nothing in the
  server requests it.

`SCHEDULE_SOURCE_HOSTS` is unchanged, and no link reaches the network that
could not before.

## What is in them

Both follow one fixed weekly pattern, so an item keeps its date, title and
UID from one build to the next: a re-sync updates the same rows, and a task
marked done stays done. Numbers such as Homework 10 count the weeks of a
16-week term from Monday 24 August 2026 and start again after week 16.

**Class schedule**, every week from the Monday two weeks before this week to
the Monday ten weeks after it, one `VEVENT` per section with a weekly `RRULE`
and Indianapolis wall-clock times under a `VTIMEZONE`, like the timetable
export. Rooms are building codes on the app's campus map, so Directions finds
them.

| Course | Meets | Time | Room |
| --- | --- | --- | --- |
| MA 16600 Lecture | Mon, Wed, Fri | 9:30 to 10:20 AM | LDPI 108 |
| MA 16600 Recitation | Mon, Fri | 3:30 to 4:20 PM | LDPI 129 |
| CS 18000 Lecture | Mon, Wed, Fri | 11:30 AM to 12:20 PM | SLPI 108 |
| CS 18000 Laboratory | Wed | 3:30 to 5:20 PM | SLPI 010 |
| PHYS 17200 Lecture | Tue, Thu | 10:30 to 11:45 AM | LE 101 |
| PHYS 17200 Recitation | Tue | 4:30 to 5:20 PM | LDPI 214 |
| PHYS 17200 Laboratory | Thu | 3:00 to 4:50 PM | LDPI 236 |
| ENGL 10600 Lecture | Tue, Thu | 1:30 to 2:45 PM | CA 331 |

**Brightspace calendar**, what is due from the start of today to that same
Monday, as `<item> - <course> - Due` in UTC like Brightspace's feed, at 11:59
PM unless noted:

- every week: Lab (CS 18000) on Wednesday, Homework (MA 16600) on Friday,
  Reading Response (ENGL 10600) on Sunday, and a quiz, PHYS 17200 on Tuesday
  in odd weeks and CS 18000 on Monday in even ones, each with Brightspace's
  "Availability Starts" marker, which the sync drops;
- even weeks: a Lab Report (PHYS 17200) on Thursday;
- weeks 2, 6, 10 and 14: an Essay (ENGL 10600) on Sunday;
- weeks 4, 8, 12 and 16: a Project (CS 18000) on Friday;
- weeks 7 and 13: an evening exam, PHYS 17200, Thursday 6:30 to 7:30 PM in
  LE 101.

Past coursework is left out: the app lists unfinished past work as Overdue,
and nobody ticks off the demo's. The re-sync sweeps an item once its day is
over. Homework every Friday means something is always due within a week, and
`test/demoCalendars.test.mjs` checks that and a class this week at every hour
of a year.

## Who can add them

Anyone signed in can paste the links, and doing so fills only their own
account with the same made-up data, so there is no per-account list. With
`PURDUE_AUTH_MODE=cas` the Purdue link, like any Purdue schedule, needs a
linked Purdue account first; production runs `off` today, so the demo account
needs none.

## Switching them off

`DEMO_CALENDARS` is on unless set to `off` (or `0` / `false`) on Render. Off:

- a new demo link is refused like any other host ("That calendar provider is
  not allowed.");
- a demo source already added fails its next sync as a dead feed would, still
  without a fetch, and keeps its imported items until it is removed;
- both links answer 404.

## Changing the data

Edit `SECTIONS` or `courseworkOfWeek` in `src/demoCalendars.mjs`, then the
timetable that `test/demoCalendars.test.mjs` pins. Keep rooms on the app's
campus map (`src/lib/campus-buildings.json` in the app repository). An evening
class works too: since #523 a weekly meeting keeps its own Indianapolis day.
