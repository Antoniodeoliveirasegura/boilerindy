# Marketplace photo uploads

The mobile app and the website both prepare a JPEG (maximum 1600-pixel edge,
5 MiB) on the device. The Express API uses the existing student session to
authorize a direct Supabase Storage upload, and either client attaches the
verified photo through the create / edit API. Listings carry up to six ordered
photos; the first is the cover. The website shows the cover on cards and the
full gallery on the detail panel, and its form takes one uploaded photo (the
cover) plus image links, while the mobile form uploads several device photos.
Pricing choices are Set price, Free and Best offer; zero always displays as Free.

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
3. Run `db/supabase-marketplace-gallery-pricing.sql` in Supabase SQL Editor first.
   It adds/backfills `image_urls` and `price_mode`, preserving the legacy cover.
   It can be rerun. Leave these additive columns in place if rolling back code.
   Then ship this backend change through the repo's develop-to-main release flow and
   deploy/restart the existing Express service. Merely configuring the bucket or
   changing the mobile app's demo flag does not install these endpoints.
4. Use the mobile app with `EXPO_PUBLIC_USE_MOCKS=0`, restart Metro, sign in, and
   link Purdue. Create and edit a listing with several photos. Verify every image on
   the website and on a second device. Existing URL-only clients remain supported.
5. Run the cleanup command regularly in the backend hosting environment. The
   command is provided below; no external schedule is created by this change.

Never put the server key or session secret in mobile `EXPO_PUBLIC_*` variables.
The mobile app uses its existing Supabase public key and project URL.

## API

`GET /api/marketplace/capabilities` requires authentication and verifies the new
columns exist before returning `{ gallery: true, pricing: true, maxPhotos: 6 }`.
Clients check this before uploads/writes so an older deployment cannot silently
ignore gallery or price mode fields.

Create/PATCH accepts `priceMode: "fixed" | "free" | "best_offer"` and `priceCents`.
Free normalizes to zero; best offer normalizes to null. A fixed price of zero is
also Free. An omitted fixed price is unspecified, never implicitly free.
Unrelated patches preserve pricing.

Create/PATCH accepts ordered `photos: [{ url }, { receipt }]`, maximum six.
The first photo is the cover, an empty array clears all photos, and omitting the
field preserves the gallery. A retained bucket URL must already belong to that
listing; new uploads require receipts. Duplicate URLs and mixed legacy/gallery
fields are rejected. API reads include `images` and legacy `imageUrl`.

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

The legacy single-image fields still work: create/PATCH accepts `imageUploadReceipt`
instead of `imageUrl`. The API verifies the signature, seller, target listing,
expiry, Storage size/content type, actual byte length and JPEG start/end markers
before writing the canonical public URL. These are format checks, not a full image
decoder or content moderation service. A new attachment cannot be made by
supplying a raw bucket URL. An existing URL can be preserved by an old website
edit. Other HTTP(S) image links still work.

The app awaits upload and then save, locks competing actions, and keeps its draft
and selected photos on failure. Each successful upload is reused on retries until
near expiry, including when a later photo upload fails. Photos convert and upload
sequentially to bound memory. Sellers can remove photos and choose the cover.
Unmounting during upload prevents a subsequent listing save. Cancelled, failed and
abandoned objects are swept later. Demo mode never sends photo bytes to live Storage.

## Website

`boilerindy-react/src/lib/marketplacePhotos.ts` runs the same pipeline in the
browser: `prepareListingPhoto` decodes the picked file (`createImageBitmap`
with EXIF orientation applied, `<img>` as the fallback), draws it onto a canvas
inside 1600 px and re-encodes to JPEG, stepping quality and size down until it
fits 5 MiB. That also turns PNG, WebP and (where the browser can decode it,
i.e. Safari) HEIC into JPEG, and drops the trailer data some phone cameras
append after the end-of-image marker, which the server's check would reject.
`uploadListingPhoto` then calls the authorize route, PUTs the bytes with the
existing browser Supabase client (`uploadToSignedUrl`), and returns the
receipt. `reuploadListingPhoto` refreshes a receipt that sat open past its
two-hour life without asking for the photo again.

`pages/Marketplace.tsx` renders the cover the way the app does (category tile
underneath, image on top) and the whole gallery on the detail panel, and owns
the photo field: one uploaded photo becomes the cover, an "Image links" box
adds up to six photos in order (the same box lists a listing's current photos
when editing, so removing a line removes that photo and clearing it sends
`photos: []`), a failed upload keeps the draft and the photo and offers Retry,
and posting is held until the photo is ready or removed. The form checks
`/api/marketplace/capabilities` before writing. The pricing menu maps to
`priceMode`; the price box only shows for a set price. `blob:` is allowed in
the site's `img-src` for the previews.

## Cleanup

Cleanup checks both the legacy cover and every gallery reference, including
soft-deleted listings. The gallery migration must be applied before cleanup runs.

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
restrictions, incomplete/corrupt files, ownership checks, error redaction,
cleanup reference retention/dry run, gallery ordering and rejection rules, and
pricing normalization. Run with Node 22 and the frozen pnpm lockfile.

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

## Gallery rollout acceptance (pending)

Automated checks: backend and website suites, website TypeScript, ESLint and
production build pass. Mobile tests cover mixed saved/uploaded photos, partial
upload failure, retry reuse, cover selection, the six-photo cap, pricing
normalization and unsupported-server protection.

The SQL has been applied to production (read-only checks on 2026-09-09 confirmed
the columns and the backfill). After deploying, verify the capabilities endpoint
with a signed-in session, then create a six-photo listing (including an iPhone
HEIC), edit its cover / remove / add photos, and reopen it on the website and a
second account. Verify Free and Best offer, including changing between them and
a numeric price. Restore any temporary test-account verification after acceptance
is finished.
