// Points git at the committed hooks in .githooks/. Runs from the root
// package.json "prepare" script, so `pnpm install` on a fresh clone wires the
// hooks up with no extra step (README "Conventions"). A silent no-op when
// there is no git checkout or no git on PATH, and it never fails the install:
// the hooks are a convenience for the person committing, CI is the gate.

import { execFileSync } from 'node:child_process'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

try {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0)
  let current = ''
  try {
    current = git(['config', '--get', 'core.hooksPath'])
  } catch {
    // unset
  }
  if (current === '.githooks') process.exit(0)
  git(['config', 'core.hooksPath', '.githooks'])
  console.log('git hooks: core.hooksPath set to .githooks (pre-commit and commit-msg checks)')
} catch {
  // Not a checkout, or git is missing (a build host working from an export).
}
