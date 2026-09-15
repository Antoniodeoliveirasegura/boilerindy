// Remove orphaned marketplace photos from Supabase Storage: managed objects older
// than 24 hours that no listing references as its cover or in its gallery.
// Details in docs/marketplace-photos.md.
//
// Dry run by default (counts candidates only); --apply deletes them:
//
//   node scripts/cleanup-marketplace-photos.mjs
//   node scripts/cleanup-marketplace-photos.mjs --apply

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { cleanupMarketplacePhotos } from '../src/marketplacePhotos.mjs'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
try {
  const result = await cleanupMarketplacePhotos(supabase, { dryRun: !process.argv.includes('--apply') })
  console.log({ dryRun: !process.argv.includes('--apply'), ...result })
} catch (err) {
  console.error('Photo cleanup failed:', err?.message || err)
  console.error('No further objects were removed; check server configuration and retry.')
  process.exitCode = 1
}
