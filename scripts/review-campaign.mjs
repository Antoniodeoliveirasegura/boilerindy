// Owner-only campaign review/approval. Advertisers can submit a campaign for
// review (status -> pending_review) but cannot activate it themselves; this
// script is the approval gate until an admin UI exists (advertiser-portal M2).
//
// Run from the REPO ROOT so dotenv picks up the root .env:
//
//   node scripts/review-campaign.mjs --list                 # show campaigns awaiting review
//   node scripts/review-campaign.mjs --id=<uuid> --status=active   # approve (go live)
//   node scripts/review-campaign.mjs --id=<uuid> --status=paused   # pause
//   node scripts/review-campaign.mjs --id=<uuid> --status=draft    # send back to the advertiser
//
// --status prints the target Supabase host and asks you to type it back before
// updating; add --yes to skip the prompt (required when stdin is not a terminal).

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { CAMPAIGN_STATUSES, assertBannerCreative } from '../src/advertiserCampaign.mjs'
import { confirmWriteTarget } from './lib/confirmTarget.mjs'

function parseArgs(argv) {
  const args = {}
  for (const token of argv) {
    const flag = /^--([^=]+)(?:=(.*))?$/.exec(token)
    if (flag) args[flag[1]] = flag[2] === undefined ? true : flag[2]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from the repo root so .env is loaded.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

if (args.list) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, name, placement, status, advertiser_id, created_at')
    .eq('status', 'pending_review')
    .order('created_at', { ascending: true })
  if (error) {
    console.error('ERROR listing campaigns:', error.message)
    process.exit(1)
  }
  if (!data || data.length === 0) {
    console.log('No campaigns awaiting review.')
    process.exit(0)
  }
  console.log(`${data.length} campaign(s) awaiting review:\n`)
  for (const c of data) {
    console.log(`  ${c.id}  [${c.placement}]  "${c.name}"  advertiser=${c.advertiser_id}  submitted=${c.created_at}`)
  }
  console.log('\nApprove with: node scripts/review-campaign.mjs --id=<uuid> --status=active')
  process.exit(0)
}

const id = typeof args.id === 'string' ? args.id : ''
const status = typeof args.status === 'string' ? args.status : ''
if (!id || !status) {
  console.error('Usage: node scripts/review-campaign.mjs --list')
  console.error('       node scripts/review-campaign.mjs --id=<uuid> --status=<active|paused|ended|draft> [--yes]')
  process.exit(1)
}
if (!CAMPAIGN_STATUSES.includes(status)) {
  console.error(`ERROR: status must be one of: ${CAMPAIGN_STATUSES.join(', ')}`)
  process.exit(1)
}

// The campaign as it stands is shown before the confirmation, and the update is
// tied to that version, as in the admin console: an advertiser edit in between
// leaves the campaign alone instead of putting live what nobody reviewed.
const { data: current, error: readError } = await supabase
  .from('campaigns')
  .select('id, name, status, placement, creative, updated_at')
  .eq('id', id)
  .maybeSingle()
if (readError) {
  console.error('ERROR reading campaign:', readError.message)
  process.exit(1)
}
if (!current) {
  console.error(`ERROR: no campaign found with id ${id}`)
  process.exit(1)
}
console.log(`Campaign "${current.name}" (${current.id}): ${current.status}, ${current.placement}, last changed ${current.updated_at}`)
console.log(JSON.stringify(current.creative, null, 2))
if (status === 'active' && (current.status === 'draft' || current.status === 'pending_review')) {
  try {
    assertBannerCreative(current.creative, current.placement)
  } catch (err) {
    console.error(`ERROR: ${err.message}`)
    process.exit(1)
  }
}

await confirmWriteTarget({ action: `set campaign ${id} to status ${status}`, yes: args.yes === true })

const { data, error } = await supabase
  .from('campaigns')
  .update({ status, updated_at: new Date().toISOString() })
  .eq('id', id)
  .eq('status', current.status)
  .eq('updated_at', current.updated_at)
  .select('id, name, status')
if (error) {
  console.error('ERROR updating campaign:', error.message)
  process.exit(1)
}
if (!data || data.length === 0) {
  console.error('ERROR: the campaign changed after it was shown above. Run the command again to review the latest version.')
  process.exit(1)
}

console.log(`Campaign "${data[0].name}" (${data[0].id}) is now: ${data[0].status}`)
