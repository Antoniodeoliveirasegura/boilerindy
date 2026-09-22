import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { findAssistantCredits, findDashes, isDashExempt } from '../scripts/lib/conventions.mjs'

// README "Conventions". The rules apply to every contributor, with or without
// an AI assistant, so they live in one place (scripts/lib/conventions.mjs) and
// run in three: the CI "conventions" job, the committed hooks in .githooks/,
// and `pnpm run check:conventions`. These tests pin the rules themselves and
// the wiring that makes a fresh clone pick them up.

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')
const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)

test('findDashes reports em and en dash lines and leaves hyphens alone', () => {
  const text = ['plain - hyphen', `em ${EM} dash`, 'nothing', `en ${EN} dash`].join('\n')
  assert.deepEqual(
    findDashes(text).map((h) => h.line),
    [2, 4],
  )
  assert.deepEqual(findDashes('a - b, c: d'), [])
  assert.equal(findDashes(`x ${EM} y`)[0].excerpt, `x ${EM} y`)
})

test('isDashExempt skips lockfiles and binary assets only', () => {
  for (const path of ['pnpm-lock.yaml', 'boilerindy-react/pnpm-lock.yaml', 'a.lock', 'icon.svg', 'x.png', 'f.woff2', 'f.ttf', 'p.jpeg']) {
    assert.equal(isDashExempt(path), true, path)
  }
  for (const path of ['README.md', 'server.mjs', 'db/supabase-schema.sql', '.github/workflows/ci.yml', 'e2e/auth.spec.js']) {
    assert.equal(isDashExempt(path), false, path)
  }
})

test('findAssistantCredits flags AI trailers and footers, not people', () => {
  const flagged = [
    'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>',
    'Co-authored-by: Claude <noreply@anthropic.com>',
    'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
    'Co-Authored-By: Cursor Agent <agent@cursor.com>',
    'Co-Authored-By: ChatGPT <noreply@openai.com>',
    'Generated with [Claude Code](https://claude.com/claude-code)',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ]
  for (const line of flagged) {
    assert.equal(findAssistantCredits(`fix: something\n\n${line}\n`).length, 1, line)
  }
  const allowed = [
    'Co-Authored-By: Elhadj Diallo <elhadj@example.com>',
    'Co-authored-by: dependabot[bot] <support@github.com>',
    'Signed-off-by: dependabot[bot] <support@github.com>',
    'Reviewed by a person who uses Claude at work.',
    'docs: note that the assistant reply is generated with Groq',
  ]
  for (const line of allowed) {
    assert.deepEqual(findAssistantCredits(`fix: something\n\n${line}\n`), [], line)
  }
  assert.deepEqual(findAssistantCredits('feat: plain message'), [])
  const hits = findAssistantCredits('a\nb\nCo-Authored-By: Claude <noreply@anthropic.com>')
  assert.equal(hits[0].line, 3)
})

test('the committed hooks are executable in git and call the checker', () => {
  // The mode is read from the index, not the filesystem, so a Windows checkout
  // (which cannot store the executable bit) gives the same answer as CI.
  for (const [hook, subcommand] of [
    ['pre-commit', 'dashes --staged'],
    ['commit-msg', 'commit-msg "$1"'],
  ]) {
    const entry = execFileSync('git', ['ls-files', '-s', `.githooks/${hook}`], { cwd: ROOT, encoding: 'utf8' })
    assert.match(entry, /^100755 /, `.githooks/${hook} must be tracked as executable (git update-index --chmod=+x)`)
    const body = read(`.githooks/${hook}`)
    assert.match(body, /^#!\/bin\/sh/, `.githooks/${hook} needs a POSIX sh shebang`)
    assert.ok(body.includes(`scripts/check-conventions.mjs ${subcommand}`), `.githooks/${hook} must run "${subcommand}"`)
  }
})

test('pnpm install wires the hooks and both package roots refuse npm', () => {
  const root = JSON.parse(read('package.json')).scripts
  const frontend = JSON.parse(read('boilerindy-react/package.json')).scripts
  assert.equal(root.prepare, 'node scripts/setup-git-hooks.mjs', 'root "prepare" must point git at .githooks/')
  for (const [name, scripts] of [['package.json', root], ['boilerindy-react/package.json', frontend]]) {
    assert.match(scripts.preinstall ?? '', /only-allow pnpm/, `${name} "preinstall" must run only-allow pnpm`)
  }
  assert.match(root['check:conventions'] ?? '', /check-conventions\.mjs dashes/, 'check:conventions must run the dash scan')
  assert.match(root['check:conventions'] ?? '', /check-conventions\.mjs commits/, 'check:conventions must run the commit scan')
})

test('the CI conventions job runs all three checks with full history', () => {
  const ci = read('.github/workflows/ci.yml')
  const job = ci.split(/^  conventions:/m)[1]
  assert.ok(job, 'ci.yml has no "conventions" job')
  assert.match(job, /fetch-depth: 0/, 'the commit scan needs the full history')
  for (const command of ['check-conventions.mjs dashes', 'check-conventions.mjs commits', 'check-conventions.mjs pr-body']) {
    assert.ok(job.includes(command), `conventions job must run ${command}`)
  }
  assert.match(job, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/, 'the PR body must reach the script through env, not the shell line')
  // The dash scan moved out of the test job; it must not run twice.
  assert.equal((ci.match(/check-conventions\.mjs dashes/g) ?? []).length, 1)
})
