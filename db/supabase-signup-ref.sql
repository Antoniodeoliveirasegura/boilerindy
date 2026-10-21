-- Sign-up source: users.signup_ref, the tag of the marketing link that brought
-- each new account (flyer-a, ig-bio, an ambassador's slug), so the owner can
-- count sign-ups per channel without a third-party tracker. See
-- docs/analytics.md and scripts/signup-refs.mjs.
--
-- The server sets it once, in the request that creates the account, from the
-- ?ref= (or ?utm_source=) the visitor arrived with, and only while it is still
-- NULL, so no later sign-in can overwrite it. NULL means no tagged link: a
-- direct visit, a sign-up from the native app, or an account created before
-- this column. The CHECK repeats the slug rule of src/signupRef.mjs.
--
-- Until this runs nothing breaks: sign-up works as before, and the server logs
-- once that this file has not run and saves no source.
--
-- Idempotent and safe to re-run. Existing accounts keep NULL; no row is written.

ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ref TEXT
  CONSTRAINT users_signup_ref_slug
  CHECK (signup_ref IS NULL OR (signup_ref ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(signup_ref) <= 40));
