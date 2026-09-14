// Brand posture guard (issue #112, docs/brand.md): the app must not paint
// Purdue's exact official gold (#CFB991). The React design tokens use
// BoilerIndy's own gold (#D4A84B light / #E8C878 dark); this catches the
// literal creeping back into the server-rendered pages, transactional email
// or any client source file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_EXT = new Set(['.mjs', '.js', '.ts', '.tsx', '.css', '.html'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_EXT.has(path.extname(name))) out.push(full)
  }
  return out
}

test('no source file uses Purdue\'s official gold #CFB991', () => {
  const files = [
    path.join(ROOT, 'server.mjs'),
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'boilerindy-react', 'src')),
    ...walk(path.join(ROOT, 'boilerindy-react', 'public')),
  ]
  const offenders = files.filter((f) => /cfb991/i.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), [])
})
