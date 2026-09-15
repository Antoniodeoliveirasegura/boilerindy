// Remove orphaned marketplace photos from Supabase Storage: managed objects older
// than 24 hours that no listing references as its cover or in its gallery.
// Details in docs/marketplace-photos.md.
//
// Dry run by default (counts candidates only); --apply deletes them:
//
//   node scripts/cleanup-marketplace-photos.mjs
//   node scripts/cleanup-marketplace-photos.mjs --apply
//
// --apply prints the target Supabase host and asks you to type it back before
// deleting; add --yes to skip the prompt (required when stdin is not a terminal).

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { cleanupMarketplacePhotos } from '../src/marketplacePhotos.mjs'
import { confirmWriteTarget } from './lib/confirmTarget.mjs'

const apply = process.argv.includes('--apply')
if (apply) {
  await confirmWriteTarget({
    action: 'delete orphaned marketplace photos from Storage',
    yes: process.argv.includes('--yes'),
  })
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
try {
  const result = await cleanupMarketplacePhotos(supabase, { dryRun: !apply })
  console.log({ dryRun: !apply, ...result })
} catch (err) {
  console.error('Photo cleanup failed:', err?.message || err)
  console.error('No further objects were removed; check server configuration and retry.')
  process.exitCode = 1
}
