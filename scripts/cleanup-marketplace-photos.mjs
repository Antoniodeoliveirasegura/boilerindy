import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { cleanupMarketplacePhotos } from '../src/marketplacePhotos.mjs'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
try {
  const result = await cleanupMarketplacePhotos(supabase, { dryRun: !process.argv.includes('--apply') })
  console.log({ dryRun: !process.argv.includes('--apply'), ...result })
} catch {
  console.error('Photo cleanup failed. No further objects were removed; check server configuration and retry.')
  process.exitCode = 1
}
