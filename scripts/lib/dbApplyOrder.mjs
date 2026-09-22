// The db/ apply order, read from README "Database setup". That numbered list
// is the only place the run order is written down, so scripts/check-db-apply.mjs
// replays it in CI and test/dbApplyOrder.test.mjs checks, with no database,
// that it names every file in db/ and nothing else.

import { readdirSync } from 'node:fs'

const SECTION = /^## Database setup[ \t]*$/m
const NEXT_SECTION = /^## /m
const FILE_REF = /`db\/(supabase-[a-z0-9-]+\.sql)`/g

// Statements CI cannot run on a stock Postgres: the pg_cron and pg_net
// extensions are Supabase extras, and db/ci/prelude.sql provides their schemas
// instead. Everything else in every file runs as written.
const UNAVAILABLE_EXTENSION = /^\s*create extension if not exists (pg_cron|pg_net)\b.*;[ \t]*$/i

/** File names under db/, in README order, without duplicates. */
export function readmeApplyOrder(readme) {
  const start = readme.search(SECTION)
  if (start < 0) throw new Error('README.md has no "## Database setup" section')
  const rest = readme.slice(start + '## Database setup'.length)
  const end = rest.search(NEXT_SECTION)
  const section = end < 0 ? rest : rest.slice(0, end)
  const order = []
  for (const match of section.matchAll(FILE_REF)) {
    if (!order.includes(match[1])) order.push(match[1])
  }
  return order
}

/** The .sql files directly under db/ (db/ci/ is CI scaffolding, not a migration). */
export function dbFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
}

/** `sql` without the extension statements CI cannot run, plus the lines removed. */
export function stripUnavailableExtensions(sql) {
  const removed = []
  const kept = sql.split('\n').filter((line) => {
    if (UNAVAILABLE_EXTENSION.test(line)) {
      removed.push(line.trim())
      return false
    }
    return true
  })
  return { sql: kept.join('\n'), removed }
}
