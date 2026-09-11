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
   `disabled`, `cas-config`, `cas-mode`, `missing-ticket`, `link-failed` (for
   example the Purdue email is already linked to another account; `message`
   carries the same text the website shows).

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
- The website flow (`?next=` and the cookie) is unchanged; `t` and `next` are
  never combined, `t` wins.

## Local testing

With `PURDUE_AUTH_MODE=mock`, sign in on the website, then:

```bash
curl -s -b 'pih.sid=<cookie>' -X POST http://127.0.0.1:3000/api/purdue/link-token
```

Open the returned `connectUrl` in a private window (no website cookie): the mock
form appears, and submitting it redirects to `boilerindyapp://purdue-linked?status=ok`.
Opening the same `connectUrl` again redirects with `reason=used`.
