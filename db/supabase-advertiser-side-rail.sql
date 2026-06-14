-- Add side-rail placement for desktop sponsor banners.
-- Run once in Supabase SQL Editor if campaigns already exist.

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_placement_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_placement_check
  CHECK (placement IN ('home-widget', 'side-rail', 'dining', 'transit', 'events'));
