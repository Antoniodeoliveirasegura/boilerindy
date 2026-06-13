// Clear a stale Purdue link from public.users (e.g. after Supabase Auth account reset).
//
//   node scripts/clear-purdue-link.mjs --email=tsadou05@gmail.com
//   node scripts/clear-purdue-link.mjs --purdue=you@purdue.edu
//   node scripts/clear-purdue-link.mjs --email=tsadou05@gmail.com --apply

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

function parseArgs(argv) {
  const args = { apply: false }
  for (const token of argv) {
    if (token === '--apply') args.apply = true
    else {
      const match = /^--([^=]+)=(.*)$/.exec(token)
      if (match) args[match[1]] = match[2]
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const loginEmail = args.email?.trim().toLowerCase()
const purdueEmail = args.purdue?.trim().toLowerCase()

if (!loginEmail && !purdueEmail) {
  console.error('Usage: node scripts/clear-purdue-link.mjs --email=you@gmail.com [--apply]')
  console.error('   or: node scripts/clear-purdue-link.mjs --purdue=you@purdue.edu [--apply]')
  process.exit(1)
}

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let query = supabase.from('users').select('id, email, purdue_email, purdue_linked_at, created_at')
if (loginEmail) query = query.eq('email', loginEmail)
if (purdueEmail) query = query.eq('purdue_email', purdueEmail)

const { data: rows, error } = await query
if (error) {
  console.error('Query failed:', error.message)
  process.exit(1)
}

if (!rows?.length) {
  console.log('No matching user rows found.')
  process.exit(0)
}

console.log('Matching profiles:')
for (const row of rows) {
  console.log(`  id=${row.id}`)
  console.log(`    login email:  ${row.email}`)
  console.log(`    purdue email: ${row.purdue_email || '(none)'}`)
  console.log(`    linked at:    ${row.purdue_linked_at || '(never)'}`)
}

const withPurdue = rows.filter((r) => r.purdue_email)
if (!withPurdue.length) {
  console.log('\nNo Purdue link to clear on these rows.')
  process.exit(0)
}

if (!args.apply) {
  console.log('\nDry run only. Re-run with --apply to clear purdue_email on the row(s) above.')
  process.exit(0)
}

for (const row of withPurdue) {
  const { error: updateError } = await supabase
    .from('users')
    .update({
      purdue_email: null,
      purdue_username: null,
      purdue_linked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)

  if (updateError) {
    console.error(`Failed to clear ${row.id}:`, updateError.message)
    process.exit(1)
  }
  console.log(`Cleared Purdue link on ${row.email} (${row.id})`)
}

console.log('Done. Sign out and back in, then link Purdue again from Setup.')
