#!/usr/bin/env node
// Applies every db/*.sql file, in the order README "Database setup" lists
// them, to an empty database, and stops at the first error. The "db" job in
// .github/workflows/ci.yml runs it against a stock postgres:15 service
// container after db/ci/prelude.sql has stood in for what Supabase provides
// (roles, auth schema, pg_cron and pg_net objects; see that file). It proves
// what a diff cannot show: every file parses, every file's dependencies come
// earlier in the list, and the list covers all of db/.
//
// Locally, against any throwaway Postgres named by the usual PG* variables:
//   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres pnpm run check:db
// It creates the database boilerindy_ci_apply on that server, drops it first
// if it exists, and drops it again on success. Never point it at a Supabase
// project: the prelude creates roles that already exist there and would fail,
// and the intent is a scratch server anyway.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dbFiles, readmeApplyOrder, stripUnavailableExtensions } from './lib/dbApplyOrder.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DB_DIR = `${ROOT}db/`
const DATABASE = 'boilerindy_ci_apply'

function psql(database, sql, label) {
  const result = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', database, '-f', '-'], {
    input: sql,
    encoding: 'utf8',
  })
  if (result.error) {
    console.error(`psql could not start (${result.error.message}). Install the Postgres client and set PGHOST/PGPORT/PGUSER/PGPASSWORD.`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`${label} failed:`)
    console.error((result.stderr || result.stdout).trim())
    process.exit(1)
  }
}

const order = readmeApplyOrder(readFileSync(`${ROOT}README.md`, 'utf8'))
const files = dbFiles(DB_DIR)
const missing = files.filter((f) => !order.includes(f))
const extra = order.filter((f) => !files.includes(f))
if (missing.length || extra.length) {
  if (missing.length) console.error(`In db/ but not in README "Database setup": ${missing.join(', ')}`)
  if (extra.length) console.error(`In README "Database setup" but not in db/: ${extra.join(', ')}`)
  console.error('README "Database setup" must list every db/ file, in the order they are applied.')
  process.exit(1)
}

psql('postgres', `drop database if exists ${DATABASE};\ncreate database ${DATABASE};`, `create database ${DATABASE}`)
psql(DATABASE, readFileSync(`${DB_DIR}ci/prelude.sql`, 'utf8'), 'db/ci/prelude.sql')

let skipped = 0
order.forEach((file, i) => {
  const { sql, removed } = stripUnavailableExtensions(readFileSync(`${DB_DIR}${file}`, 'utf8'))
  skipped += removed.length
  for (const line of removed) console.log(`  skipping (not on a stock Postgres): ${line}`)
  psql(DATABASE, sql, `${i + 1}. db/${file}`)
  console.log(`${String(i + 1).padStart(2)}. db/${file} applied`)
})

const version = spawnSync('psql', ['-X', '-A', '-t', '-d', DATABASE, '-c', 'show server_version'], { encoding: 'utf8' }).stdout.trim()
psql('postgres', `drop database ${DATABASE};`, `drop database ${DATABASE}`)
console.log(`Applied all ${order.length} db/ files in README order on Postgres ${version} (${skipped} extension statement(s) skipped).`)
