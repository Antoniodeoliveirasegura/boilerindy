// The API route inventory (issue #191): every `app.<verb>('/path', ...)` in
// server.mjs and every `router.<verb>('/path', ...)` under src/routes/, as a
// markdown table both clients can read.
//
//   node scripts/list-routes.mjs           print the table
//   node scripts/list-routes.mjs --write   rewrite docs/api-routes.md
//   pnpm run docs:routes                   the same
//
// test/apiRoutesDoc.test.mjs fails when the committed file is behind the code,
// so a route added or moved without regenerating the inventory does not merge.
// No dependencies, like the other scripts here.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DOC_PATH = 'docs/api-routes.md'
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']
// Routes registered on the app, or on a router inside a feature file. Paths
// are absolute in both, so the inventory reads the same before and after a
// group moves into src/routes/.
const ROUTE_RE = /^\s*(?:app|router)\.(get|post|patch|put|delete)\(\s*'([^']+)'/gm

/** The files the inventory reads, in the order they are scanned. */
export function routeFiles(root = ROOT) {
  const files = ['server.mjs']
  const routesDir = path.join(root, 'src', 'routes')
  if (existsSync(routesDir)) {
    for (const name of readdirSync(routesDir).sort()) {
      if (name.endsWith('.mjs')) files.push(path.posix.join('src/routes', name))
    }
  }
  return files
}

/** Every route as { method, path, file }, sorted by path then method. */
export function collectRoutes(root = ROOT) {
  const rows = []
  for (const file of routeFiles(root)) {
    const text = readFileSync(path.join(root, file), 'utf8')
    for (const match of text.matchAll(ROUTE_RE)) {
      rows.push({ method: match[1].toUpperCase(), path: match[2], file })
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method))
  return rows
}

/** The markdown document for a set of rows. */
export function renderRoutesDoc(rows) {
  const files = [...new Set(rows.map((r) => r.file))]
  const lines = [
    '# API routes',
    '',
    'Every route the backend serves, generated from the source by',
    '`node scripts/list-routes.mjs --write` (`pnpm run docs:routes`). Do not edit by',
    'hand: `test/apiRoutesDoc.test.mjs` fails when this file is behind the code.',
    'Paths are as registered; `:id` style parameters are the route\'s own names.',
    'Rate limits per route are in [RATE_LIMITS.md](RATE_LIMITS.md), error codes in',
    '[api-error-codes.md](api-error-codes.md).',
    '',
    `${rows.length} routes in ${files.length} file${files.length === 1 ? '' : 's'}: ${files.map((f) => `\`${f}\``).join(', ')}.`,
    '',
    '| Method | Path | File |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.method} | \`${r.path}\` | \`${r.file}\` |`),
    '',
  ]
  return lines.join('\n')
}

function main() {
  const doc = renderRoutesDoc(collectRoutes())
  if (process.argv.includes('--write')) {
    writeFileSync(path.join(ROOT, DOC_PATH), doc)
    console.log(`wrote ${DOC_PATH}`)
  } else {
    process.stdout.write(doc)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
