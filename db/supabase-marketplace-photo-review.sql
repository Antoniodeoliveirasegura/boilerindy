-- Marketplace photo review (issue #504, README step 46): new listing photos
-- wait for an admin before other students see them, behind the server switch
-- MARKETPLACE_PHOTO_REVIEW (off by default). See docs/moderation.md, "Photo
-- review".
--
-- photos_review is the state of a listing's photos:
--   approved  the default, so every existing row stays as it is;
--   pending   a create or an edit added a photo while the switch was on: only
--             the seller and admins get the photo URLs until an admin decides;
--   rejected  an admin rejected them, and image_url and image_urls were cleared.
-- photos_reviewed_at and photos_reviewed_by record the last admin decision.
-- Deleting that admin's account keeps the decision and clears the name.
--
-- Needs db/supabase-marketplace.sql (step 13) and the users table (step 1).
-- Idempotent and safe to rerun; it writes no rows. Until it runs nothing
-- breaks while the switch is off: every listing reads as approved, the admin
-- photo queue answers 503 photo_review_schema_missing and the admin overview
-- shows no count. With the switch on before this runs, posting or editing a
-- listing with photos answers 503 photo_review_schema_missing, and listings
-- without photos still post.

BEGIN;

ALTER TABLE public.marketplace_listings
  ADD COLUMN IF NOT EXISTS photos_review TEXT NOT NULL DEFAULT 'approved'
    CONSTRAINT marketplace_photos_review_state CHECK (photos_review IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS photos_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS photos_reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- The admin queue: listings with pending photos, the longest waiting first.
CREATE INDEX IF NOT EXISTS marketplace_photo_review_queue_idx
  ON public.marketplace_listings (updated_at) WHERE photos_review = 'pending';

-- Deleting an account clears photos_reviewed_by on the listings it reviewed,
-- which looks the rows up by this column.
CREATE INDEX IF NOT EXISTS marketplace_photos_reviewed_by_idx
  ON public.marketplace_listings (photos_reviewed_by) WHERE photos_reviewed_by IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
