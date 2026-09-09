-- Run before deploying the gallery/pricing API. Additive and safe to rerun.
BEGIN;
ALTER TABLE public.marketplace_listings
  ADD COLUMN IF NOT EXISTS image_urls text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS price_mode text NOT NULL DEFAULT 'fixed';
UPDATE public.marketplace_listings
  SET image_urls = ARRAY[image_url]
  WHERE image_url IS NOT NULL AND cardinality(image_urls) = 0;
UPDATE public.marketplace_listings SET price_mode = 'free' WHERE price_cents = 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_image_count' AND conrelid = 'public.marketplace_listings'::regclass) THEN
    ALTER TABLE public.marketplace_listings ADD CONSTRAINT marketplace_image_count CHECK (cardinality(image_urls) <= 6);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_price_mode' AND conrelid = 'public.marketplace_listings'::regclass) THEN
    ALTER TABLE public.marketplace_listings ADD CONSTRAINT marketplace_price_mode CHECK (price_mode IN ('fixed', 'free', 'best_offer'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS marketplace_image_urls_idx ON public.marketplace_listings USING gin (image_urls);
NOTIFY pgrst, 'reload schema';
COMMIT;
