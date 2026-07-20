import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

// Issue #114 Part 2. Every table in db/ must have RLS enabled.
//
// The server talks to Supabase with SUPABASE_SERVICE_ROLE_KEY, which bypasses
// RLS, so policies cannot protect the server's own queries. What RLS does
// protect is the Data API: Supabase exposes every table in the public schema
// over HTTP to anyone holding the (public, shipped-in-the-bundle) anon key.
// RLS enabled with zero policies denies that role everything, which is the
// posture this repo relies on.
//
// So the dangerous regression is not "a policy is wrong", it is "a new table
// shipped without ENABLE ROW LEVEL SECURITY" - that table is readable by
// anyone the moment it exists. This test fails on exactly that.

const DB_DIR = new URL('../db/', import.meta.url)

function readAllSql() {
  return readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(new URL(f, DB_DIR), 'utf8'))
    .join('\n')
}

function tableNames(sql, re) {
  return new Set(Array.from(sql.matchAll(re), (m) => m[1].toLowerCase()))
}

const sql = readAllSql()
const created = tableNames(sql, /CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi)
const rlsEnabled = tableNames(sql, /ALTER TABLE\s+([a-z_]+)\s+ENABLE ROW LEVEL SECURITY/gi)

test('db/ declares at least one table (guards against a broken scan)', () => {
  assert.ok(created.size > 0, 'no CREATE TABLE found in db/*.sql - the pattern or the path is wrong')
})

test('every table in db/ has row level security enabled', () => {
  const missing = [...created].filter((t) => !rlsEnabled.has(t)).sort()
  assert.deepEqual(
    missing,
    [],
    'these tables are reachable with the anon key over the Supabase Data API. ' +
      `Add "ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;" beside each CREATE TABLE: ${missing.join(', ')}`,
  )
})

test('RLS is not enabled for a table that does not exist (catches renames and typos)', () => {
  const orphans = [...rlsEnabled].filter((t) => !created.has(t)).sort()
  assert.deepEqual(orphans, [], `ENABLE ROW LEVEL SECURITY names an unknown table: ${orphans.join(', ')}`)
})
