# Sign in with Apple token revocation

When a student who signs in with Apple deletes their account, the backend
revokes their Sign in with Apple token through Apple's REST API, which Apple
asks of every app that offers Sign in with Apple ([developer news,
2022-05-24, "Account deletion requirement starts
June 30"](https://developer.apple.com/news/?id=12m75xbj);
[TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)).
Only the native app (`Antoniodeoliveirasegura/boilerindy-app`) offers Sign in
with Apple, so only it sends the token; the website offers Google.

## Why the app sends the token

Checked on 2026-10-24 against the Supabase docs and the Supabase Auth source
(`supabase/auth` at
[`c3348e8`](https://github.com/supabase/auth/tree/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f)):

- Supabase does not revoke anything when a user is deleted.
  `supabase.auth.admin.deleteUser` ends in `adminUserDelete`
  ([`internal/api/admin.go`](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/api/admin.go#L595-L659)),
  which writes an audit entry and deletes the user (or soft-deletes it with its
  identities, factors and sessions) and calls no provider. It has nothing to
  revoke with either: "Provider tokens are intentionally not stored in your
  project's database" ([Supabase, Provider
  tokens](https://supabase.com/docs/guides/auth/social-sign-in#provider-tokens)).
- Apple's OAuth sign-in (`signInWithOAuth`, what the app uses for Apple and
  Google) hands Apple's tokens to the client once. Supabase Auth authorizes
  with the first Client ID of its Apple provider, which must be the Services
  ID ([Supabase, Sign in with
  Apple](https://supabase.com/docs/guides/auth/social-sign-in/auth-apple);
  [`provider/apple.go`](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/api/provider/apple.go#L106-L108)),
  exchanges Apple's code for Apple's access and refresh tokens
  ([`external_oauth.go`](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/api/external_oauth.go#L119-L146)),
  keeps them in the PKCE flow state
  ([`external.go`](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/api/external.go#L242-L243))
  and returns them as `provider_token` and `provider_refresh_token` from the
  code exchange
  ([`token.go`](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/api/token.go#L270-L275)),
  then deletes the flow state.
- So the fresh Apple sign-in that the app's delete screen already asks for
  (Confirm with Apple) carries a refresh token issued to the Services ID, and
  the app sends it with the delete request.

## The request and the answer

`POST /api/me/delete-account` takes two optional fields besides
`confirmation` and `password`:

| Field | Value |
|---|---|
| `appleToken` | Apple's refresh token (`provider_refresh_token`) from the Confirm with Apple sign-in, or its access token (`provider_token`) when there is no refresh token |
| `appleTokenType` | `refresh_token` (the default) or `access_token` |

The confirmation and the proof of identity are checked first, so a refused
request never reaches Apple. Then the token is revoked, and then the Supabase
Auth user and the profile row are deleted as before. Revoking first keeps a
retry possible: if the deletion fails, the student can send it again. A
missing, unconfigured or failed revoke never keeps the account.

An account that is not an Apple one and sent no token gets the same
`{ ok: true }` as before. Otherwise the answer adds `appleRevocation`:
`{ ok: true, appleRevocation: { revoked: true } }` once Apple has taken the
revoke, or `{ revoked: false, reason }`:

| `reason` | Meaning |
|---|---|
| `no-token` | An Apple account deleted without a token: with its password in the app, or on the website |
| `bad-token` | The token or its type cannot be one, so it was not sent to Apple |
| `not-configured` | One of the four settings below is blank or wrong; the boot log says which |
| `rejected` | Apple answered an error. The log has its status and error code: `invalid_client` means the Services ID, Key ID, Team ID and key do not belong together |
| `timeout` | Apple did not answer within 5 seconds |
| `network` | The connection to Apple failed |
| `error` | Anything else |

When `revoked` is not `true` for an Apple account, the app tells the student
to remove BoilerIndy from Sign in with Apple themselves (Settings, your name,
Sign in with Apple, BoilerIndy, Delete: [Apple
Support](https://support.apple.com/en-us/102571)), which is what TN3194 asks
for when there is no token to revoke.

## How the revoke works

`src/appleTokenRevoke.mjs`, called from `deleteUserAccount` in
`src/routes/auth.mjs`:

- `POST https://appleid.apple.com/auth/revoke`, form-encoded, with
  `client_id`, `client_secret`, `token` and `token_type_hint`
  ([Apple, Token
  revocation](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens)),
  under a 5 second deadline.
- `client_id` is the Services ID. Apple wants the identifier the token was
  issued to ("must match the value provided during the authorization
  request"), and Supabase's OAuth flow authorizes with the Services ID, not
  the app's bundle ID.
- `client_secret` is an ES256 JWT: header `alg: ES256` and `kid` (the Key
  ID), claims `iss` (the Team ID), `iat`, `exp`, `aud:
  https://appleid.apple.com` and `sub` (the Services ID) ([Apple, Creating a
  client
  secret](https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret)).
  The backend signs a new one for each request, valid five minutes (Apple
  allows six months), so it never needs the six-month rotation the secret in
  Supabase's Apple provider does.
- Apple answers 200 when the token is revoked or was already invalid, so a
  200 shows Apple took the request, not that the token was still live.
- The token and the client secret are never logged. Each deletion logs
  `[deleteUserAccount] Sign in with Apple token revoked`, or `... not revoked
  (<reason>[, Apple answered <status> <error>]); deleting the account
  anyway`. While a setting is missing, boot logs `[apple] <what>: deleting an
  account will not revoke its Sign in with Apple token.`

## Settings

All four come from the Apple Developer account and go on Render (Environment),
never in the repo. `.env.example` lists them.

| Variable | Where to get it |
|---|---|
| `APPLE_TEAM_ID` | [developer.apple.com/account](https://developer.apple.com/account), Membership details: the 10-character Team ID |
| `APPLE_SIGN_IN_KEY_ID` | Certificates, Identifiers & Profiles, Keys: a key with Sign in with Apple enabled and configured for the app's primary App ID, and its 10-character Key ID. The key the Supabase Apple secret was made with will do |
| `APPLE_SIGN_IN_PRIVATE_KEY` | The contents of that key's `AuthKey_<Key ID>.p8` file, from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`. Apple lets you download it once, when the key is created. On one line, write each line break as `\n` |
| `APPLE_SIGN_IN_SERVICES_ID` | Certificates, Identifiers & Profiles, Identifiers, Services IDs: the identifier (for example `com.example.app.web`), the same one listed first under Client IDs in Supabase's Apple provider |

## Checking it

1. Set the four on Render. After the deploy the boot log has no `[apple]`
   line.
2. In the app, sign in with Apple as a disposable account and delete it with
   Confirm with Apple.
3. The Render log shows `[deleteUserAccount] Sign in with Apple token
   revoked`. On the iPhone, Settings, your name, Sign in with Apple no longer
   lists BoilerIndy, and Apple may email that the app revoked the Sign in with
   Apple account.
4. `rejected` with `invalid_client` instead: check that the four belong
   together and that the Services ID is the first Client ID in Supabase.

## Limits

- An Apple account deleted on the website (it can only use a password there)
  is answered with `no-token`, and the website does not show the manual step.
- Supabase Auth does not take Apple's server-to-server notifications ("At
  this time Supabase Auth does not support Server-to-Server notification
  endpoints", [Supabase, Sign in with
  Apple](https://supabase.com/docs/guides/auth/social-sign-in/auth-apple)), so
  a student who removes BoilerIndy in their Apple settings is not signed out
  or deleted here.
- Apple notes that developers based in the Republic of Korea must provide a
  server-to-server notification endpoint when they register a new Services ID
  ([Offering account deletion in your
  app](https://developer.apple.com/support/offering-account-deletion-in-your-app/)).
  BoilerIndy has no such endpoint.
