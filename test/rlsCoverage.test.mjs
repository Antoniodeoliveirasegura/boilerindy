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
//
// Issue #212 hardened the scan. It used to read only the exact spellings the
// repo happened to use, so a table written `CREATE TABLE public.foo` or a
// grant written `ALTER TABLE ONLY public.foo ENABLE ROW LEVEL SECURITY` was
// invisible to it: the first went unreported, the second reported a table that
// is in fact covered. Both spellings are what a dump or a generated migration
// produces, so the next file someone pastes in could carry them. The scan now
// tolerates `public.`, `IF NOT EXISTS` and `ONLY`, strips comments first, and
// runs through one `coverage()` function so the fixtures below pin the same
// code that reads the real files.

const DB_DIR = new URL('../db/', import.meta.url)

// db/*.sql only, never db/ci/. db/ci/prelude.sql stands in for what a Supabase
// project ships with and creates cron.job and cron.job_run_details without RLS
// on purpose: they are Supabase's tables, outside the public schema the Data
// API exposes, and a recursive read would report both as missing coverage.
function readAllSql() {
  return readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(new URL(f, DB_DIR), 'utf8'))
    .join('\n')
}

// db/supabase-calendar-indexes.sql keeps a commented-out CREATE INDEX as
// rollback instructions, and a commented CREATE TABLE would read as a real one.
// No db/*.sql file uses block comments or puts "--" inside a string literal, so
// stripping to end of line is enough.
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '')

const CREATE_TABLE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?([a-z_]+)/gi
const ENABLE_RLS = /ALTER TABLE(?:\s+IF EXISTS)?(?:\s+ONLY)?\s+(?:public\.)?([a-z_]+)\s+ENABLE ROW LEVEL SECURITY/gi

function tableNames(sql, re) {
  return new Set(Array.from(sql.matchAll(re), (m) => m[1].toLowerCase()))
}

function coverage(sqlText) {
  const sql = stripComments(sqlText)
  const created = tableNames(sql, CREATE_TABLE)
  const rlsEnabled = tableNames(sql, ENABLE_RLS)
  return {
    created,
    rlsEnabled,
    missing: [...created].filter((t) => !rlsEnabled.has(t)).sort(),
    orphans: [...rlsEnabled].filter((t) => !created.has(t)).sort(),
  }
}

// There are no policies in db/ today, and that is the posture: RLS on, zero
// policies, so the anon and authenticated roles are denied everything. If a
// policy ever does land, these are the four shapes that hand those roles real
// access rather than scoping a row to its owner.
const OPEN_TO_DATA_API = [
  [/\bTO\s+anon\b/i, 'TO anon'],
  [/\bTO\s+public\b/i, 'TO public'],
  [/\bUSING\s*\(\s*true\s*\)/i, 'USING (true)'],
  [/\bWITH\s+CHECK\s*\(\s*true\s*\)/i, 'WITH CHECK (true)'],
]

function openPolicies(sqlText) {
  const found = []
  for (const m of stripComments(sqlText).matchAll(/CREATE POLICY\s+("[^"]+"|[a-z_0-9]+)[\s\S]*?;/gi)) {
    const why = OPEN_TO_DATA_API.filter(([re]) => re.test(m[0])).map(([, label]) => label)
    if (why.length) found.push(`${m[1].toLowerCase()} (${why.join(', ')})`)
  }
  return found.sort()
}

// Five board indexes are declared twice on purpose: db/supabase-schema.sql and
// the db/supabase-board-only.sql fallback carry identical copies, so whichever
// one a project ran, the indexes exist. That is fine while the two copies stay
// identical and a silent trap once they drift, because the second CREATE INDEX
// IF NOT EXISTS is a no-op and the project keeps the definition it got first.
const CREATE_INDEX = /CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF NOT EXISTS)?\s+([a-z_0-9]+)\s+([\s\S]*?);/gi

function indexDefinitions(sqlText) {
  const byName = new Map()
  for (const m of stripComments(sqlText).matchAll(CREATE_INDEX)) {
    const name = m[1].toLowerCase()
    const def = m[2].replace(/\s+/g, ' ').trim().toLowerCase()
    if (!byName.has(name)) byName.set(name, new Set())
    byName.get(name).add(def)
  }
  return byName
}

function conflictingIndexes(sqlText) {
  return [...indexDefinitions(sqlText)]
    .filter(([, defs]) => defs.size > 1)
    .map(([name, defs]) => `${name}: ${[...defs].sort().join(' | ')}`)
    .sort()
}

const sql = readAllSql()
const real = coverage(sql)

test('db/ declares at least one table (guards against a broken scan)', () => {
  assert.ok(real.created.size > 0, 'no CREATE TABLE found in db/*.sql - the pattern or the path is wrong')
})

test('every table in db/ has row level security enabled', () => {
  assert.deepEqual(
    real.missing,
    [],
    'these tables are reachable with the anon key over the Supabase Data API. ' +
      `Add "ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;" beside each CREATE TABLE: ${real.missing.join(', ')}`,
  )
})

test('RLS is not enabled for a table that does not exist (catches renames and typos)', () => {
  assert.deepEqual(real.orphans, [], `ENABLE ROW LEVEL SECURITY names an unknown table: ${real.orphans.join(', ')}`)
})

test('a schema-qualified table with no RLS is reported missing', () => {
  const { created, missing } = coverage('CREATE TABLE public.foo (id uuid primary key);')
  assert.deepEqual([...created], ['foo'])
  assert.deepEqual(missing, ['foo'])
})

test('ALTER TABLE ONLY public.<name> counts as coverage', () => {
  const { missing, orphans } = coverage(
    ['CREATE TABLE bar (id uuid primary key);', 'ALTER TABLE ONLY public.bar ENABLE ROW LEVEL SECURITY;'].join('\n'),
  )
  assert.deepEqual(missing, [])
  assert.deepEqual(orphans, [])
})

test('commented-out SQL is not read as a declaration', () => {
  const { created } = coverage('-- CREATE TABLE ghost (id uuid);\nCREATE TABLE real_one (id uuid);')
  assert.deepEqual([...created], ['real_one'])
})

test('no policy in db/ grants the Data API roles anything', () => {
  const open = openPolicies(sql)
  assert.deepEqual(
    open,
    [],
    'RLS in this repo is "enabled with zero policies", which denies anon everything. ' +
      `These policies hand it access instead: ${open.join(', ')}`,
  )
})

test('the policy guard catches a policy opened to anon', () => {
  assert.deepEqual(openPolicies('CREATE POLICY p ON foo FOR SELECT TO anon USING (true);'), [
    'p (TO anon, USING (true))',
  ])
  assert.deepEqual(openPolicies('CREATE POLICY p ON foo FOR SELECT TO authenticated USING (user_id = auth.uid());'), [])
})

test('an index name declared twice in db/ has one definition', () => {
  const conflicts = conflictingIndexes(sql)
  assert.deepEqual(
    conflicts,
    [],
    'the same index name is created with different definitions in two files. ' +
      'CREATE INDEX IF NOT EXISTS is a no-op the second time, so a project keeps whichever ' +
      `ran first and the two installs diverge silently: ${conflicts.join('; ')}`,
  )
})

test('the index guard catches two definitions of one name', () => {
  const drifted = ['CREATE INDEX IF NOT EXISTS idx_x ON t (a);', 'CREATE INDEX IF NOT EXISTS idx_x ON t (b);'].join('\n')
  assert.deepEqual(conflictingIndexes(drifted), ['idx_x: on t (a) | on t (b)'])
  const same = ['CREATE INDEX IF NOT EXISTS idx_x ON t (a);', 'CREATE INDEX IF NOT EXISTS idx_x    ON t (a);'].join('\n')
  assert.deepEqual(conflictingIndexes(same), [])
})

test('the four issue #212 indexes are declared', () => {
  const names = indexDefinitions(sql)
  for (const name of [
    'idx_board_posts_user',
    'idx_marketplace_listings_user',
    'idx_guide_recommendations_user',
    'idx_study_group_members_user',
  ]) {
    assert.ok(names.has(name), `${name} is missing from db/`)
  }
})
