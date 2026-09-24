import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DOC_PATH, collectRoutes, renderRoutesDoc } from '../scripts/list-routes.mjs'

// Issue #191 - docs/api-routes.md is generated from server.mjs and src/routes/,
// so the router split can show, PR by PR, that no route was lost and none
// changed shape: only the File column moves.

const root = new URL('../', import.meta.url)

test('the committed route inventory matches the code', () => {
  const committed = readFileSync(fileURLToPath(new URL(DOC_PATH, root)), 'utf8')
  const generated = renderRoutesDoc(collectRoutes())
  assert.equal(committed, generated, `${DOC_PATH} is behind the code: run pnpm run docs:routes and commit the result`)
})

test('the inventory sees every app-level route in server.mjs', () => {
  const server = readFileSync(fileURLToPath(new URL('server.mjs', root)), 'utf8')
  const appRoutes = [...server.matchAll(/^app\.(get|post|patch|put|delete)\('([^']+)'/gm)].length
  const rows = collectRoutes()
  assert.equal(rows.filter((r) => r.file === 'server.mjs').length, appRoutes)
  // Sorted by path, then method, so a regenerated file diffs cleanly.
  const sorted = [...rows].sort((a, b) => a.path.localeCompare(b.path))
  assert.deepEqual(rows.map((r) => r.path), sorted.map((r) => r.path))
})
