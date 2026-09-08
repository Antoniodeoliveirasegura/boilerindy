# Marketplace photo uploads

The mobile app prepares a JPEG (maximum 1600-pixel edge, 5 MiB). The Express API
uses the existing student session to authorize a direct Supabase Storage upload.
The website can display the resulting image through its existing `imageUrl` field.
There is no database migration and no new upload UI on the website.

## Server configuration and rollout

1. Use the same Supabase project as the app. The existing `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` authorize server operations. `SESSION_SECRET` (or
   existing `BETTER_AUTH_SECRET`) must be at least 32 characters; it signs photo
   receipts with a separate `marketplace-photo-v1` domain. Do not rotate it as
   part of installation: doing so invalidates sessions and pending receipts.
2. Create `marketplace-images`: public, maximum 5242880 bytes, allowed MIME types
   `image/jpeg`, `image/png`, `image/webp`. The server checks these settings before
   issuing an authorization. Public means anyone with a URL can read a photo.
   Keep upload/update/delete access restricted; no public INSERT policy is needed.
3. Ship this backend change through the repo's develop-to-main release flow and
   deploy/restart the existing Express service. Merely configuring the bucket or
   changing the mobile app's demo flag does not install these endpoints.
4. Use the mobile app with `EXPO_PUBLIC_USE_MOCKS=0`, restart Metro, sign in, and
   link Purdue. Create and edit a listing with a photo. Verify the same image on
   the website and on a second device. Existing URL-only clients remain supported.
5. Run the cleanup command regularly in the backend hosting environment. The
   command is provided below; no external schedule is created by this change.

Never put the server key or session secret in mobile `EXPO_PUBLIC_*` variables.
The mobile app uses its existing Supabase public key and project URL.

## API

`POST /api/marketplace/photos/authorize` requires `requireAuth`, a linked Purdue
account, and a per-user limit of 20 requests/hour (the existing in-memory limiter;
limits are per process and reset on restart). The body is
`{ contentType: "image/jpeg", byteSize: number, listingId?: string }`.
An edit must reference an existing, non-deleted listing owned by the current user.
The response is `{ upload: { bucket, path, token, receipt, expiresAt } }` with
`Cache-Control: no-store`. Treat the token and receipt as credentials; do not log.

The generated path is `managed/<user UUID>/<issue timestamp>-<random UUID>.jpg`.
Upload using `uploadToSignedUrl(path, token, arrayBuffer, { contentType: "image/jpeg" })`.
Overwrite is disabled on the signed token. The authorization and receipt last two
hours. The file becomes publicly readable at upload time, before listing save.

Create/PATCH accepts `imageUploadReceipt` instead of `imageUrl`. The API verifies
the signature, seller, target listing, expiry, Storage size/content type, actual
byte length and JPEG start/end markers before writing the canonical public URL.
These are format checks, not a full image decoder or content moderation service.
A new attachment cannot be made by supplying a raw bucket URL. An existing URL
can be preserved by an old website edit. Other HTTP(S) image links still work.

The app awaits upload and then save, locks competing actions, and keeps its draft
and selected photo on failure. A successful upload is reused on a save retry until
near expiry; selecting another photo clears it. Unmounting during upload prevents
a subsequent listing save. Cancelled/failed/abandoned objects are swept later.
Demo mode never sends photo bytes to live Storage.

## Cleanup

```sh
node scripts/cleanup-marketplace-photos.mjs          # counts candidates only
node scripts/cleanup-marketplace-photos.mjs --apply  # removes candidates
```

Only recognized managed objects older than 24 hours are considered, after their
attachment receipts have expired. Every candidate is checked against all listing
rows before deletion. Soft-deleted and hidden listings retain their images for
moderation/restore; admin hard purge releases them for cleanup. Replaced photos
and abandoned uploads are collected. Manual/legacy bucket files are untouched.
Pagination is completed before deleting to avoid skipping items. A database or
Storage error stops the run; rerunning is safe. Do not enable a blanket bucket
TTL, which would also delete images referenced by active listings.

## Verification

Backend unit tests cover seller/listing binding, expiry and tampering, upload
restrictions, incomplete/corrupt files, ownership checks, error redaction and
cleanup reference retention/dry run. Run with Node 22 and the frozen pnpm lockfile.

An explicit Storage-only smoke test takes a JPEG under 100 KB, creates one random
test object, verifies it and its public bytes, then removes that exact object in
`finally`. It never creates a student account or a listing:

```sh
node scripts/test-marketplace-photo-storage.mjs /path/to/test.jpg --live
```

Set `DOTENV_CONFIG_PATH` if the server environment file is elsewhere. Optionally
set `SUPABASE_SMOKE_PUBLIC_KEY` to test the mobile client's actual public key;
otherwise the upload uses only the signed URL with no authentication header.
The test also checks that the token cannot overwrite its uploaded object.

Live student authentication, HTTP create/edit persistence and real iPhone HEIC
selection still need acceptance against the deployed backend; Storage success
alone does not verify those paths.
