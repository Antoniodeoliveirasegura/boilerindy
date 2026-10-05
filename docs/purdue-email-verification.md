# Purdue email verification

How a student links a `@purdue.edu` address to their BoilerIndy account by
typing a six-digit code mailed to it, with no Purdue CAS round trip and no
admin or database step (issue #181). A student who signed up with a personal
email can then post to the Marketplace, which needs a linked Purdue address.

## What it proves

Mailbox ownership, and nothing else. A verified code writes the same link a CAS
link writes (`purdue_email`, `purdue_username`, `purdue_linked_at` on the
student's `users` row) through the same `linkPurdueIdentity` in `src/purdueIdentity.mjs`,
so every rule of a CAS link applies unchanged: a profile holds one Purdue
address, an address belongs to one profile (`users.purdue_email` is unique),
and the account-recovery and orphan-row cases resolve as they do for CAS. The
session's `user.hasPurdueLinked`, the Settings card and the Marketplace posting
gate read that link the same way whichever path wrote it.

It is not a Purdue sign-in. It does not touch the login email, the sign-in
method, CAS (`/auth/purdue/*`, see [purdue-link.md](purdue-link.md)), the dev
mock link, the schedule import ([schedule-import.md](schedule-import.md), issue
#120) or Brightspace. The routes work in every `PURDUE_AUTH_MODE`, `off`
included, since reading a mailbox is all they check.

## The table

`db/supabase-purdue-email-verification.sql` (README "Database setup" step 39,
needs step 1 only) creates `purdue_email_challenges`, one row per code sent:
`id`, `user_id` (cascades with the user), `email`, `code_hash`, `expires_at`,
`attempts`, `consumed_at` and `created_at`, with an index on
`(user_id, created_at desc)`. RLS is on and there are no policies: only the
server, with the service-role key, reads or writes it.

The code itself is never stored. `code_hash` is the SHA-256 of
`<challenge id>:<code>`, so a leaked row cannot be replayed and a hash is
useless outside its own row. A new request deletes the student's earlier rows,
so only the newest code can work. Nothing is unique on `email`: a code claims
nothing, and the unique `users.purdue_email` decides who holds an address when
a code is verified.

Until step 39 runs nothing breaks: the three routes below answer
`503 purdue_email_verification_schema_missing` and every other way of linking
is unchanged.

Rollback: `DROP TABLE IF EXISTS purdue_email_challenges;`. Nothing else
changes, and addresses already linked stay linked.

## Limits

- A code is six digits and works for 10 minutes, for up to 5 wrong tries.
  After that the student requests a new one.
- A new code can be requested once a minute, whether or not the last one was
  used (a `429` with `Retry-After`).
- The `purdue-verify` limiter allows 10 requests an hour per student across
  the request and verify routes (see [RATE_LIMITS.md](RATE_LIMITS.md)), which
  bounds both the mail any one address receives and the guesses at a code.

The rules live in `src/purdueEmailVerification.mjs` and the routes in
`src/routes/purdueEmail.mjs`. All three need a signed-in student.

## POST /api/me/purdue-email/request

Mails a code to the address. Limited by `purdue-verify`.

```json
{ "email": "jdoe@purdue.edu" }
```

The address is trimmed and lowercased. It must end in exactly `@purdue.edu` (no
subdomain or lookalike), with a local part of letters, digits, dots,
underscores and hyphens, up to 64 characters (no plus tags, so one mailbox
cannot verify two accounts), and 254 characters in all. The code goes to this
address, not to the student's login email.

| Answer | When |
|---|---|
| `200 { "ok": true, "email", "expiresAt", "cooldownSeconds": 60 }` | A code was sent. `expiresAt` is 10 minutes on. |
| `200 { "ok": true, "alreadyLinked": true }` | The profile already holds this address; nothing is sent. |
| `400` "Use your @purdue.edu address." | The address is not one the flow accepts. |
| `400` "Your BoilerIndy profile is already linked to a different Purdue account. Contact support to release that link before linking another one." | The profile holds another Purdue address (the message `linkPurdueIdentity` uses). |
| `429 { "error": { "message": "Please wait a minute before requesting another code.", "status": 429, "retryAfterSeconds" } }` | The newest code is less than a minute old; `Retry-After` carries the same seconds. |
| `429` "Too many verification attempts. Please try again in an hour." | Over the `purdue-verify` limit. |
| `503` "We could not send the code right now. Please try again in a few minutes." | The email did not go out. The code is deleted, so nothing is pending and no cooldown applies. |
| `503 purdue_email_verification_schema_missing` | Step 39 has not run. |
| `500` "Could not start verification. Please try again." | Any other database failure. |
| `401` | Not signed in. |

No answer says whether the address belongs to someone else, so the route cannot
be used to find out who has linked what.

## POST /api/me/purdue-email/verify

Checks a code against the student's newest challenge and links its address.
Limited by `purdue-verify`.

```json
{ "code": "042917" }
```

| Answer | When |
|---|---|
| `200 { "ok": true, "purdueEmail": "jdoe@purdue.edu" }` | The code was right; the address is linked. |
| `400` "Enter the 6-digit code." | `code` is not six digits (spaces are ignored). |
| `400` "Request a code first." | There is no code, or it was already used. |
| `400` "That code has expired. Request a new one." | The code is past its 10 minutes or its 5 wrong tries, or a second right answer sent at the same moment used it first. |
| `400` "That code is not right." | A wrong code; it counts toward the 5. |
| `400` with `linkPurdueIdentity`'s message | The address is held by another profile, or this profile now holds another address. The code is spent and the existing link is untouched. |
| `429`, `503`, `500`, `401` | As for the request route. |

The code is spent before the link is written, and only if it is still unspent,
so two right answers in flight link once and a code never works twice. A wrong
code is counted against the count it was read at, and read again if another
wrong code counted first, so parallel guesses each count. `linkPurdueIdentity`
writes nothing until its checks pass, so a refused link leaves the student's
existing link as it was. Only a student who has just shown they read the
mailbox can learn that the address is held elsewhere.

## GET /api/me/purdue-email/status

```json
{ "linked": false, "purdueEmail": null, "pending": { "email": "jdoe@purdue.edu", "expiresAt": "2026-09-27T12:10:00.000Z", "attemptsLeft": 5 } }
```

`linked` and `purdueEmail` read the student's row. `pending` is the newest code
while it is unused and unexpired, and `null` otherwise; `attemptsLeft` of `0`
means the student has to request a new code. Answers `503` and `500` as above.

## The email

`purdueVerificationEmail` in `src/email.mjs`, sent through `sendEmail`
(Resend), is a transactional message: the subject "Your BoilerIndy
verification code", the code set large, "It expires in 10 minutes.", a line
saying to ignore it if it was not asked for, and no link. It uses the same
`RESEND_API_KEY`, `RESEND_FROM` and `MAIL_REPLY_TO` as the advertiser password
reset.

Without `RESEND_API_KEY` and `RESEND_FROM`, development logs the code with a
masked address (`[purdue-email] dev code for j***@purdue.edu: 042917`) and
answers as if it was sent, so the flow works locally. Production deletes the
code and answers the `503` instead, and logs that email is not configured. A
code is never logged in production and never sent back in an answer.

## Owner steps

Before the release that carries this:

1. Confirm on Render that `RESEND_API_KEY` and `RESEND_FROM` are set and that
   the sending domain is verified in Resend. Nothing in the repository records
   it, and without them every request answers the `503` in production.
2. Run README step 39 (`db/supabase-purdue-email-verification.sql`) in the
   Supabase SQL Editor.

## What a client needs to call

The website (issue #181, second PR) and later the native app call `status`
when the Purdue card opens, `request` with the address the student typed,
then `verify` with the code, and refresh the session after a `200` from
`verify` so `user.hasPurdueLinked` and the Marketplace flip without a reload.
A `cooldownSeconds` or `retryAfterSeconds` tells the client when to enable
"Send a new code".

## On the website

`components/PurdueEmailVerification.tsx` is the card: the address, then the
code with a resend countdown from `cooldownSeconds` (or a `429`'s
`retryAfterSeconds`), the server's own words for a wrong, expired or used-up
code and for a failed delivery, and the verified state. A verified code
refreshes the session and marks the per-user queries stale, so
`user.hasPurdueLinked`, the onboarding summary and the Marketplace posting gate
flip without a reload. A code sent before a reload is picked up again from
`status`, through `usePurdueEmailStatus()` (key `['me', userId, 'purdue-email']`,
see [client-cache.md](client-cache.md)).

- **Settings**: the Purdue account card shows in every `PURDUE_AUTH_MODE`.
  Unlinked, it holds the card, plus "Sign in with Purdue instead" in `cas`
  mode.
- **Setup** (`/setup`): where linking is required (`needsPurdueConnection`, in
  `cas` and `mock` mode), the Purdue step still comes first, with the card, the
  CAS button in `cas` mode and "Link without a code (development)", the dev
  mock link, in `mock` mode. Where it is not (`off`, as in production), an
  unlinked student gets the card as an optional section above the calendar
  sources, so connecting a calendar never waits on it.
- The Marketplace still sends an unlinked student to setup, and the Privacy
  page says Resend also delivers the codes.
