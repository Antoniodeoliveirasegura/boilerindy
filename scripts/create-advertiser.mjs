// Mint (or update) an advertiser account for the invite-only portal. There is no
// self-serve signup endpoint, so this script is how real/test advertiser accounts
// are created. Idempotent on email: re-running updates the password + company.
//
// Run from the REPO ROOT so dotenv picks up the root .env (same as the server):
//
//   node scripts/create-advertiser.mjs --email=brand@co.com --company="Acme Co" [--contact="Jo Smith"] [--yes]
//
// The password comes from ADVERTISER_PASSWORD (e.g. in .env) or, when that is
// unset, from a hidden prompt. --password=... still works but lands in shell
// history, so the script warns when it is used.
//
// Flags may also be supplied via env: ADVERTISER_EMAIL, ADVERTISER_COMPANY,
// ADVERTISER_CONTACT.
//
// Before writing it prints the target Supabase host and asks you to type it
// back; pass --yes to skip the prompt (required when stdin is not a terminal).

import 'dotenv/config'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { hashPassword } from '../src/passwordHash.mjs'
import { normalizeAdvertiserAccountInput } from '../src/advertiserAuth.mjs'
import { confirmWriteTarget, readSecretFromPrompt } from './lib/confirmTarget.mjs'

function parseArgs(argv) {
  const args = { yes: false }
  for (const token of argv) {
    if (token === '--yes') {
      args.yes = true
      continue
    }
    const match = /^--([^=]+)=(.*)$/.exec(token)
    if (match) args[match[1]] = match[2]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.password !== undefined) {
  console.warn('WARNING: --password puts the advertiser password in your shell history. Prefer ADVERTISER_PASSWORD or the prompt.')
}

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from the repo root so .env is loaded.')
  process.exit(1)
}

const input = {
  email: args.email ?? process.env.ADVERTISER_EMAIL,
  password: args.password || process.env.ADVERTISER_PASSWORD,
  companyName: args.company ?? process.env.ADVERTISER_COMPANY,
  contactName: args.contact ?? process.env.ADVERTISER_CONTACT,
}
// Only prompt once the other required fields are there, so a usage error does
// not cost a typed password.
if (!input.password && input.email && input.companyName) {
  input.password = await readSecretFromPrompt('Advertiser password')
}

let account
try {
  account = normalizeAdvertiserAccountInput(input)
} catch (error) {
  console.error('ERROR:', error.message)
  console.error('Usage: node scripts/create-advertiser.mjs --email=you@co.com --company="Acme Co" [--contact="Jo Smith"] [--yes]')
  console.error('       The password is read from ADVERTISER_PASSWORD, or prompted for when that is unset.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const now = new Date().toISOString()
const passwordHash = hashPassword(account.password)

const { data: existing, error: lookupError } = await supabase
  .from('advertisers')
  .select('id')
  .eq('email', account.email)
  .maybeSingle()

if (lookupError) {
  console.error('ERROR looking up advertiser:', lookupError.message)
  console.error('If the table is missing, run db/supabase-advertiser-portal.sql in the Supabase SQL Editor first.')
  process.exit(1)
}

await confirmWriteTarget({
  action: existing
    ? `update advertiser ${account.email} (resets password, company and contact)`
    : `create advertiser ${account.email} (${account.companyName})`,
  yes: args.yes,
})

if (existing) {
  const { error } = await supabase
    .from('advertisers')
    .update({
      password_hash: passwordHash,
      company_name: account.companyName,
      contact_name: account.contactName,
      status: 'active',
      updated_at: now,
    })
    .eq('id', existing.id)
  if (error) {
    console.error('ERROR updating advertiser:', error.message)
    process.exit(1)
  }
  console.log(`Updated existing advertiser: ${account.email}`)
  process.exit(0)
}

const { error } = await supabase.from('advertisers').insert({
  id: crypto.randomUUID(),
  email: account.email,
  password_hash: passwordHash,
  company_name: account.companyName,
  contact_name: account.contactName,
  status: 'active',
  created_at: now,
  updated_at: now,
})

if (error) {
  console.error('ERROR creating advertiser:', error.message)
  if (/Could not find the table|schema cache|does not exist/.test(error.message)) {
    console.error('Run db/supabase-advertiser-portal.sql in the Supabase SQL Editor first.')
  }
  process.exit(1)
}

console.log(`Created advertiser: ${account.email} (${account.companyName})`)
