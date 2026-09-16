# Purdue link handoff for the native app (issue #214)

The website links a Purdue identity by sending the browser to
`GET /auth/purdue/connect`, which needs the `pih.sid` session cookie. A native
app cannot reuse that: the system browser it opens for Purdue CAS
(`ASWebAuthenticationSession` on iOS, a Custom Tab on Android) has its own
cookie jar, so the route answered a JSON 401 and the link never completed.

The handoff replaces the cookie with a short-lived, single-use token that
identifies the student for exactly one link attempt.

## Sequence

1. The app, signed in with its session cookie, calls
   `POST /api/purdue/link-token`. Response:

   ```json
   {
     "token": "<payload>.<signature>",
     "expiresAt": "2026-09-11T15:10:00.000Z",
     "connectUrl": "https://boilerindy-api.onrender.com/auth/purdue/connect?t=<token>",
     "returnUrl": "boilerindyapp://purdue-linked"
   }
   ```

   Errors use the standard envelope with a `code`: `purdue_linking_disabled`
   (400, `PURDUE_AUTH_MODE=off`), `purdue_link_unconfigured` (503,
   `SESSION_SECRET` shorter than 32 characters), or 401 when not signed in.
   The route is limited to 20 calls per 15 minutes per user (`purdue-link-token`).

2. The app opens `connectUrl` with `WebBrowser.openAuthSessionAsync(connectUrl, returnUrl)`.
   The server verifies the token (without spending it), loads the student, and
   redirects to Purdue CAS with a service URL that carries the same token
   (`/auth/purdue/callback?t=<token>`). In `mock` mode it renders the mock link
   form with the token in a hidden field instead.

3. Purdue returns to `/auth/purdue/callback?t=<token>&ticket=...`. The server
   validates the ticket against the identical service URL, spends the token,
   writes the link to the student's row, and redirects to
   `boilerindyapp://purdue-linked?status=ok`.

4. On any failure the redirect is `boilerindyapp://purdue-linked?status=error&reason=<reason>&message=<text>`.
   Reasons: `invalid` (bad signature or shape), `expired` (older than 10
   minutes), `used` (already spent), `unauthorized` (student no longer exists),
   `disabled`, `cas-config`, `cas-mode`, `missing-ticket`, `rate-limited` (more
   than 30 link requests in 15 minutes, see below), `link-failed` (for example
   the Purdue email is already linked to another account, the student's
   profile is already linked to a different Purdue account, or Purdue CAS did
   not answer within 8 seconds; `message` carries the same text the website
   shows).

5. The app refetches `GET /api/session`; `user.hasPurdueLinked` is now true.

## Properties

- Tokens are HMAC-SHA256 signed with `SESSION_SECRET` under a distinct domain
  string (`purdue-link-v1`), bound to the student id, and carry their own
  expiry. They never grant a website session: the token path reads and writes
  nothing on `req.session`, so the browser that completed CAS is not signed in
  afterwards.
- Single use is enforced per server process (an in-memory set of spent token
  ids, pruned on use). After a Render restart a spent token could be presented
  again inside its remaining window; the CAS ticket it carries is single use on
  the Purdue side, and the mock flow only exists outside production.
- The return scheme comes from `NATIVE_APP_SCHEME` (default `boilerindyapp`),
  validated against the RFC 3986 scheme grammar, never from the request, so the
  callback cannot be turned into an open redirect.
- The website flow (`?next=` and the cookie) is bound to the session that
  started it by a single-use `state` nonce (issue #293). `GET
  /auth/purdue/connect` stores a random nonce in the session and adds it to the
  service URL, so it is part of what CAS signs; the callback spends the nonce
  before anything else and refuses a missing or wrong `state` with
  `/settings?error=purdue-link-state`, before any call to Purdue and before any
  write. The native flow never carries a `state`: the signed token binds it.
  `t` and `next` are never combined, `t` wins.
- Connect, the mock form and the callback share the `purdue-link-flow` limit
  (30 per 15 minutes, see [RATE_LIMITS.md](RATE_LIMITS.md)), checked before the
  student is loaded. A live token is its own bucket, then the website session
  user, then the IP, so a forged `t` never buys a fresh budget. A throttled
  request is still a redirect: `reason=rate-limited` for the app,
  `/settings?error=purdue-link-throttled` for the website.
- A link never replaces a different Purdue address already on the profile;
  the student is told to contact support, since only an admin can release a
  link (`POST /api/admin/purdue-links/clear`).
- Ticket validation has the same 8 second deadline as every other upstream
  call (`src/upstreamFetch.mjs`).

## Local testing

With `PURDUE_AUTH_MODE=mock`, sign in on the website, then:

```bash
curl -s -b 'pih.sid=<cookie>' -X POST http://127.0.0.1:3000/api/purdue/link-token
```

Open the returned `connectUrl` in a private window (no website cookie): the mock
form appears, and submitting it redirects to `boilerindyapp://purdue-linked?status=ok`.
Opening the same `connectUrl` again redirects with `reason=used`.

The website `state` check can be exercised in any mode, because it runs before
the ticket is looked at. Signed in, open
`http://127.0.0.1:3000/auth/purdue/callback?next=/setup&state=wrong&ticket=ST-1`:
it lands on `/settings?error=purdue-link-state` and makes no request to CAS.
