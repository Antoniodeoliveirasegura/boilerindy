// Grant platform admin to a student account (public.users.is_admin).
//
//   node scripts/grant-admin.mjs --email=you@gmail.com
//   node scripts/grant-admin.mjs --email=you@gmail.com --revoke
//
// If the column is missing, run db/supabase-admin-users.sql in Supabase SQL Editor first.

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

function parseArgs(argv) {
  const args = { revoke: false }
  for (const token of argv) {
    if (token === '--revoke') args.revoke = true
    else {
      const match = /^--([^=]+)=(.*)$/.exec(token)
      if (match) args[match[1]] = match[2]
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const email = args.email?.trim().toLowerCase()

if (!email) {
  console.error('Usage: node scripts/grant-admin.mjs --email=you@gmail.com [--revoke]')
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

const { data: user, error: lookupError } = await supabase
  .from('users')
  .select('id, email, display_name, is_admin')
  .eq('email', email)
  .maybeSingle()

if (lookupError) {
  if (lookupError.message?.includes('is_admin')) {
    console.error('Column is_admin is missing. Run db/supabase-admin-users.sql in Supabase SQL Editor, then retry.')
  } else {
    console.error('Lookup failed:', lookupError.message)
  }
  process.exit(1)
}

if (!user) {
  console.error(`No user found with email ${email}. Sign up in the app first.`)
  process.exit(1)
}

const { error: updateError } = await supabase
  .from('users')
  .update({ is_admin: !args.revoke })
  .eq('id', user.id)

if (updateError) {
  if (updateError.message?.includes('is_admin')) {
    console.error('Column is_admin is missing. Run db/supabase-admin-users.sql in Supabase SQL Editor, then retry.')
  } else {
    console.error('Update failed:', updateError.message)
  }
  process.exit(1)
}

console.log(
  args.revoke
    ? `Revoked admin from ${user.email} (${user.display_name || user.id})`
    : `Granted admin to ${user.email} (${user.display_name || user.id})`,
)
console.log('Sign out and back in for the session to pick up the change.')
