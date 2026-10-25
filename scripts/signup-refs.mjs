// Sign-ups per marketing link: how many accounts each ?ref= tag brought
// (users.signup_ref, docs/analytics.md#sign-up-source), in total and per
// campus week. Counts only: it reads signup_ref and created_at, never an email
// or a name, and prints nothing about any one account.
//
//   node scripts/signup-refs.mjs
//   node scripts/signup-refs.mjs --since=2026-10-01
//   node scripts/signup-refs.mjs --csv > signups.csv
//
// --since keeps sign-ups from that campus date on; --csv prints a row per week
// and a column per link, for a spreadsheet. Read-only, so it asks for no
// confirmation. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env, and
// README "Database setup" step 45 (db/supabase-signup-ref.sql).

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { isSchemaMissingError } from '../src/dbErrors.mjs'
import { fetchAllPages } from '../src/pagedSelect.mjs'
import { countSignups, formatSignupReport, signupReportCsv } from '../src/signupRefReport.mjs'

const USAGE = 'Usage: node scripts/signup-refs.mjs [--since=YYYY-MM-DD] [--csv]'

function parseArgs(argv) {
  const args = { csv: false, since: undefined, unknown: [] }
  for (const token of argv) {
    if (token === '--csv') args.csv = true
    else if (token.startsWith('--since=')) args.since = token.slice('--since='.length)
    else args.unknown.push(token)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.unknown.length) {
  console.error(`Unknown option: ${args.unknown.join(' ')}\n${USAGE}`)
  process.exit(1)
}
if (args.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
  console.error(`--since takes a date like 2026-10-01.\n${USAGE}`)
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

// Every account, two columns each, paged past PostgREST's 1000-row cap.
const { data: rows, error } = await fetchAllPages(
  () =>
    supabase
      .from('users')
      .select('signup_ref, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  { max: Number.MAX_SAFE_INTEGER },
)

if (error) {
  if (isSchemaMissingError(error)) {
    console.error('users.signup_ref is missing. Run db/supabase-signup-ref.sql (README "Database setup" step 45) in the Supabase SQL Editor, then retry.')
  } else {
    console.error('Reading sign-ups failed:', error.code ?? '', error.message ?? error)
  }
  process.exit(1)
}

const counts = countSignups(rows, { since: args.since })
process.stdout.write(args.csv ? signupReportCsv(counts) : formatSignupReport(counts, { since: args.since }))
