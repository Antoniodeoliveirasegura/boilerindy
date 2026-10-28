# Share links

The Share buttons on `/transit`, `/dining` and `/free-food`, the QR button
beside each header's Share, the link each one sends, and the link preview
cards a chat app shows for it. All three pages
open signed out (the public preview, issue #366), so a shared link is a free
sample for a friend: the same live map, menu or free food, under the preview
bar.

## The link

`boilerindy-react/src/lib/shareLinks.ts` builds it: the page's own path on the
site the student is on, the view on screen, and a `ref` that says where the
visit came from.

| Page | View in the link | `ref` | `ref` in a QR code |
|---|---|---|---|
| `/transit` | `route`, the route picked (`?route=31`), none for All Routes | `share-bus` | `qr-bus` |
| `/dining` | `hall`, a location slug, and `meal` (`?hall=tower-dining&meal=dinner`) | `share-dining` | `qr-dining` |
| `/free-food` | `event`, one campus event's id, from that event's own Share; none from the header's | `share-free-food` | `qr-free-food` |

Anything else in the address is left out: an earlier `ref` (a friend who
reshares a shared link sends `share-bus` again, not the ref they arrived
with), utm tags, another app's click id. The refs are slugs of `[a-z0-9-]`
of at most 40 characters, which is what the sign-up source accepts; recording
it at sign-up is that feature's job, not this one's.

The dining hall and meal live in the address, as the transit route already
did: `?hall=` and `?meal=`, written with replace (not push) when a student
picks a pill, so the pills add no Back steps. A plain `/dining` still opens on
Tower Dining and the meal being served (`defaultMeal`) and stays plain until
a pick. Picking another hall keeps the meal in the address, so coming back to
a hall finds the meal picked there. A meal the hall does not post that day
falls back to the one being served, and a hall the feed does not list to
Tower Dining. The Share button sends the hall and meal on screen even before
they are in the address, so a friend opens the same menu.

A link shares the menu, never the hall's status: the share text and the card
say nothing about a hall being open, since the feed's hours are unreliable
([dining.md](dining.md), "Weekend hours").

### Free food

`/free-food` shares two ways. The header's Share sends the whole list
(`/free-food?ref=share-free-food`), the link for a weekly "free food this
week" post, and leaves out the event a shared link opened the page on. Each
shared campus event's row has its own Share, which sends that event:
`/free-food?event=<id>&ref=share-free-food`.

- The id is the event's `campus_events` id. The page lists it as
  `campus:<id>` signed in and signed out alike (`toSharedCalendarItem` in
  `src/campusEventsFeed.mjs`), so one link finds it for either. A student's
  own calendar rows get no Share: a friend could never see them.
- A link with `?event=` opens the list on that row, once the list is in: the
  row is tinted, says "Shared with you" and is scrolled to the middle of the
  screen, once. The rest of the list stays where it is, around it.
- A link to an event no longer listed (over, or taken down by its calendar)
  says so above the list, which shows as usual. A recurring event is listed by
  its next occurrence, so a link to last week's names one that is over.
- The share sheet's line says what and when, with the day spelled out
  ("Free food at Boiler Fuel Up, Fri, Oct 23, 9:00 AM, on BoilerIndy"): a
  message stays in a chat for days, where "Today" would soon be wrong.

An event's title and time go into the chat with its link, so sharing a
BoilerLink event shows its details outside BoilerIndy. Whether SAO's approval
covers showing BoilerLink events to people without an account is issue
#366's open "redisplay" question; if it does not, the public read and these
links should leave BoilerLink's rows out.

## The button

`components/ShareButton.tsx`, in each page's header, for every visitor, and
on each campus event's row on `/free-food` as a small text button named after
its event ("Share Boiler Fuel Up"), so a screen reader tells the rows apart:

- On a phone or tablet (a coarse pointer and the Web Share API), it opens the
  system share sheet with the page title, a short line ("Dinner at Tower
  Dining, on BoilerIndy") and the link. Closing the sheet does nothing more;
  any other refusal copies the link instead.
- Elsewhere it copies the link and the button reads "Link copied" for 2.5
  seconds (announced to screen readers too). A laptop's own share sheet, where
  there is one, is slower than a paste into a group chat.
- When the clipboard refuses (some in-app browsers do), the link shows in a
  read-only field, selected, to copy by hand.

Each press records `share_clicked` with a `page` prop of `transit`, `dining`
or `free-food`, and `kind: event` when a single free-food event is shared
rather than the list ([analytics.md](analytics.md)); never the link or the
event's id. Like every event it is recorded only for a signed-in student who
has not opted out, so a signed-out friend who reshares is not counted; the
`ref` on a new account is the measure of what sharing brings in.

On `/transit`, a signed-out visitor who picks a route sees, above the stops
where a student's "my stop" bells would be, an invitation to sign in for the
chime, with a link that comes back to the same route.

## The QR code

`components/ShareQrButton.tsx`, the square button with the QR glyph just after
Share in each page's header ("Show QR code"), for every visitor. It is for a
friend standing there, who scans it with their camera, and for moving the page
from a laptop to a phone. The free-food rows have none: the list's code is one
button away.

- It opens a dialog with the view on screen as a QR code, the share line as
  its heading ("Dinner at Tower Dining, on BoilerIndy"), "Point a phone's
  camera at the code to open it. No account needed.", and the share link in a
  read-only field with Copy link, for a chat after all. A clipboard that
  refuses selects the field, to copy by hand. Done, Escape or the backdrop
  closes it, and focus goes back to the QR button.
- The code carries the Share link's view with the page's QR ref (`QR_REFS`
  in `shareLinks.ts`), so a sign-up from a scan counts apart from one from a
  chat. The link in the field keeps the share ref: it goes to a chat.
- It is drawn on the device and nothing is fetched. `lib/qrCode.ts` encodes the
  link with `uqr` (error correction M: these links make a code 33 to 37
  modules wide, so the modules stay large) and draws it as one SVG path, black
  on white in either theme inside the four-module quiet zone the standard asks
  for, since not every camera reads a light code on a dark ground. The encoder
  ships with the page (about 4 KB gzipped) rather than loading on the first
  press, so the code still shows with no signal at a bus stop.
- Each press records `share_clicked` with the page and `via: qr`; copying
  from the dialog records nothing more.

`lib/qrCode.test.ts` paints each code from its path and reads it back with
jsQR, a decoder that shares no code with the encoder.

## Link previews

A chat app (iMessage, Discord, WhatsApp, Slack) builds its card from the HTML
it fetches and never runs the app, so every address used to unfurl as the one
card in `boilerindy-react/index.html`. Each shared page now has its own:

- `boilerindy-react/src/lib/pagePreviews.ts` holds each page's title,
  description and image. The `page-previews` plugin in `vite.config.js` writes
  a copy of the built `index.html` per page (`dist/transit.html`,
  `dist/dining.html`, `dist/free-food.html`) with its `<title>`, description,
  `og:` and `twitter:` tags rewritten. The build stops if `index.html` loses
  one of those tags.
- `boilerindy-react/vercel.json` rewrites `/transit`, `/dining` and
  `/free-food` to their copies ahead of the SPA fallback `/(.*)`. A rewrite
  matches the path only, so `/transit?route=31&ref=share-bus` gets the transit
  card, and a single free-food event's link the free-food one. Headers match
  the address asked for, so these pages keep the same CSP as every other.
  `vite preview` serves `dist/transit.html` for `/transit` on its own.
- The cards, `public/og-transit.png`, `public/og-dining.png` and
  `public/og-free-food.png` (1200x630), are rendered with the other launch
  assets by `pnpm -C boilerindy-react run render-icons` and committed. The
  free-food card names no event: it serves the list and every event's link,
  and stays up in a chat long after an event is over.

Other spellings (`/transit/`, `/Dining`) fall through to the home card; the
Share buttons always send `/transit`, `/dining` and `/free-food`. The
`og:image` addresses point at `https://www.boilerindy.app`, so a preview
deployment's card shows an image only once it is released.

To see what an unfurler gets:

```bash
curl -s -A "facebookexternalhit/1.1" "https://www.boilerindy.app/transit?route=31&ref=share-bus" | grep -E "<title>|og:|twitter:"
```

Chat apps cache a card, some for days, so a changed card can take a while to
show; Facebook's Sharing Debugger can ask for a fresh one.

A card that shows today's menu, or the event a free-food link names (built
per request rather than per build), is not done.
