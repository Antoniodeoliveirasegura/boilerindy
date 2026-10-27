import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dbFiles, readmeApplyOrder, stripUnavailableExtensions } from '../scripts/lib/dbApplyOrder.mjs'

// README "Database setup" is the only record of the order the db/ files are
// applied in, and it ends with "If you add a file to db/, add it here too".
// These tests make that a rule instead of a reminder, and pin the parsing that
// scripts/check-db-apply.mjs relies on when CI replays the list on an empty
// Postgres (the "db" job in .github/workflows/ci.yml).

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')
const order = readmeApplyOrder(read('README.md'))
const files = dbFiles(fileURLToPath(new URL('db/', ROOT)))

test('README "Database setup" lists every db/ file exactly once', () => {
  assert.deepEqual(files.filter((f) => !order.includes(f)), [], 'db/ files missing from README "Database setup"')
  assert.deepEqual(order.filter((f) => !files.includes(f)), [], 'README "Database setup" names files that are not in db/')
  assert.equal(new Set(order).size, order.length)
})

test('the core schema comes first and the list is long enough to be the real one', () => {
  assert.equal(order[0], 'supabase-schema.sql')
  assert.ok(order.length >= 30, `only ${order.length} files parsed from README`)
})

test('the shared campus events table follows the core schema, and its cron snippet follows both it and keep-warm', () => {
  // db/supabase-campus-events.sql reuses uuid_generate_v4() and
  // update_updated_at_column() from step 1; the ingest cron in
  // db/supabase-campus-events-ingest.sql writes to that table and calls pg_net,
  // which db/supabase-keep-warm.sql creates (issue #30).
  const at = (file) => {
    const index = order.indexOf(file)
    assert.ok(index >= 0, `${file} is missing from README "Database setup"`)
    return index
  }
  assert.ok(at('supabase-campus-events.sql') > at('supabase-schema.sql'))
  assert.ok(at('supabase-campus-events-ingest.sql') > at('supabase-campus-events.sql'))
  assert.ok(at('supabase-campus-events-ingest.sql') > at('supabase-keep-warm.sql'))
})

test('the retention jobs follow pg_cron and the three tables they prune', () => {
  // db/supabase-retention.sql calls cron.schedule() from step 29 and deletes
  // from user_sessions, analytics_events and push_deliveries (issue #528).
  const at = (file) => order.indexOf(file)
  assert.ok(at('supabase-retention.sql') >= 0, 'supabase-retention.sql is missing from README "Database setup"')
  for (const before of ['supabase-keep-warm.sql', 'supabase-sessions.sql', 'supabase-analytics.sql', 'supabase-push.sql']) {
    assert.ok(at('supabase-retention.sql') > at(before), `supabase-retention.sql must come after ${before}`)
  }
})

test('readmeApplyOrder reads only the Database setup section, in order of appearance', () => {
  const readme = [
    '## Local Development Setup',
    'Run `db/supabase-zzz.sql` first? No, that is another section.',
    '## Database setup',
    '1. `db/supabase-schema.sql` - core',
    '2. `db/supabase-b.sql` - needs `db/supabase-schema.sql`',
    '3. `db/supabase-a.sql`',
    '## Production deployment',
    '`db/supabase-keep-warm.sql` is mentioned here too.',
  ].join('\n')
  assert.deepEqual(readmeApplyOrder(readme), ['supabase-schema.sql', 'supabase-b.sql', 'supabase-a.sql'])
  assert.throws(() => readmeApplyOrder('# nothing here'), /Database setup/)
})

test('only the two pg_cron/pg_net extension statements in keep-warm are skipped in CI', () => {
  for (const file of files) {
    const { sql, removed } = stripUnavailableExtensions(read(`db/${file}`))
    if (file === 'supabase-keep-warm.sql') {
      assert.equal(removed.length, 2, `expected the pg_cron and pg_net lines in ${file}`)
      assert.match(removed[0], /pg_cron/)
      assert.match(removed[1], /pg_net/)
      assert.doesNotMatch(sql, /create extension if not exists pg_/i)
    } else {
      assert.deepEqual(removed, [], `${file} must not need a skipped statement; add its extension to db/ci/prelude.sql instead`)
    }
  }
})

test('the CI prelude provides what the db/ files borrow from Supabase', () => {
  const prelude = read('db/ci/prelude.sql')
  for (const needle of ['create role anon', 'create role authenticated', 'create role service_role', 'function auth.uid()', 'function cron.schedule(', 'function cron.unschedule(', 'function net.http_get(', 'function net.http_post(']) {
    assert.ok(prelude.includes(needle), `db/ci/prelude.sql must define ${needle}`)
  }
})

test('the CI db job applies the list against a Postgres service', () => {
  const ci = read('.github/workflows/ci.yml')
  const job = ci.split(/^  db:/m)[1]
  assert.ok(job, 'ci.yml has no "db" job')
  assert.match(job, /image: postgres:15/, 'the db job must run on a stock postgres:15 service')
  assert.ok(job.includes('node scripts/check-db-apply.mjs'), 'the db job must run scripts/check-db-apply.mjs')
  assert.match(JSON.parse(read('package.json')).scripts['check:db'] ?? '', /check-db-apply\.mjs/, 'package.json needs a check:db script')
})
