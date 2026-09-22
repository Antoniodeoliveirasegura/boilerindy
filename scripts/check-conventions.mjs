#!/usr/bin/env node
// Command-line front for scripts/lib/conventions.mjs. Zero dependencies, so it
// runs before `pnpm install` (git hooks) and in a CI job with no install step.
//
//   node scripts/check-conventions.mjs dashes            every tracked file
//   node scripts/check-conventions.mjs dashes --staged   the staged copies (pre-commit hook)
//   node scripts/check-conventions.mjs commits [range]   commit messages in a git range
//   node scripts/check-conventions.mjs commit-msg <file> one message file (commit-msg hook)
//   node scripts/check-conventions.mjs pr-body           the PR description in $PR_BODY
//
// `commits` without a range picks one from the GitHub Actions environment:
// the pull request's commits (origin/<base>..HEAD) or the pushed commits
// ($EVENT_BEFORE..$GITHUB_SHA, falling back to HEAD alone when the old tip is
// unknown, as on a branch's first push). Outside Actions it takes
// origin/develop..HEAD, and just HEAD when origin/develop is not fetched.
// Exit code 1 on any hit, with the offending file:line or commit printed.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { findAssistantCredits, findDashes, isDashExempt } from './lib/conventions.mjs'

const NULL_SHA = /^0+$/

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function tryGit(args) {
  try {
    return git(args, { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function fail(lines) {
  console.error(lines.join('\n'))
  process.exit(1)
}

function checkDashes(staged) {
  const listArgs = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '-z']
  const files = git(listArgs).split('\0').filter(Boolean).filter((f) => !isDashExempt(f))
  const bad = []
  for (const file of files) {
    let text
    try {
      text = staged ? git(['show', `:${file}`]) : readFileSync(file, 'utf8')
    } catch {
      continue // deleted, unreadable or a submodule entry: nothing to scan
    }
    for (const hit of findDashes(text)) bad.push(`${file}:${hit.line}: ${hit.excerpt}`)
  }
  if (bad.length) {
    fail([
      'Em dash (U+2014) or en dash (U+2013) found. Use a hyphen (-). See README.md Conventions:',
      ...bad.slice(0, 50),
    ])
  }
  console.log(`No em/en dashes across ${files.length} ${staged ? 'staged' : 'tracked'} files.`)
}

function defaultRange() {
  const event = process.env.GITHUB_EVENT_NAME
  if (event === 'pull_request' && process.env.GITHUB_BASE_REF) {
    return `origin/${process.env.GITHUB_BASE_REF}..HEAD`
  }
  if (event === 'push') {
    const before = process.env.EVENT_BEFORE || ''
    const head = process.env.GITHUB_SHA || 'HEAD'
    if (before && !NULL_SHA.test(before) && tryGit(['cat-file', '-e', `${before}^{commit}`]) !== null) {
      return `${before}..${head}`
    }
    return `${head}^!`
  }
  if (tryGit(['rev-parse', '--verify', '--quiet', 'origin/develop']) !== null) return 'origin/develop..HEAD'
  return 'HEAD^!'
}

function checkCommits(range) {
  const target = range || defaultRange()
  const raw = git(['log', '--format=%H%x1f%s%x1f%B%x1e', target])
  const commits = raw.split('\x1e').map((s) => s.trim()).filter(Boolean)
  const bad = []
  for (const entry of commits) {
    const [sha, subject, body] = entry.split('\x1f')
    for (const hit of findAssistantCredits(body || '')) {
      bad.push(`${sha.slice(0, 7)} (${subject}): ${hit.excerpt}`)
    }
  }
  if (bad.length) {
    fail([
      'Commit message credits an AI assistant (Co-Authored-By trailer or "Generated with" footer).',
      'Remove the line (git commit --amend or rebase) and push again. See README.md Conventions:',
      ...bad,
    ])
  }
  console.log(`No AI co-author trailers in ${commits.length} commit(s) (${target}).`)
}

function checkMessageFile(path) {
  const message = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#')) // git's commented template lines
    .join('\n')
  const hits = findAssistantCredits(message)
  if (hits.length) {
    fail([
      'Commit message credits an AI assistant. Remove the line and commit again. See README.md Conventions:',
      ...hits.map((h) => `  line ${h.line}: ${h.excerpt}`),
    ])
  }
}

function checkPrBody() {
  const body = process.env.PR_BODY || ''
  const hits = findAssistantCredits(body)
  if (hits.length) {
    fail([
      'Pull request description credits an AI assistant. Edit the description. See README.md Conventions:',
      ...hits.map((h) => `  line ${h.line}: ${h.excerpt}`),
    ])
  }
  console.log('No AI footer in the pull request description.')
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'dashes':
    checkDashes(rest.includes('--staged'))
    break
  case 'commits':
    checkCommits(rest.find((a) => !a.startsWith('--')))
    break
  case 'commit-msg':
    if (!rest[0]) fail(['usage: check-conventions.mjs commit-msg <message-file>'])
    checkMessageFile(rest[0])
    break
  case 'pr-body':
    checkPrBody()
    break
  default:
    fail(['usage: check-conventions.mjs dashes [--staged] | commits [range] | commit-msg <file> | pr-body'])
}
