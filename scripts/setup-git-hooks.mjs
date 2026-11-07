// Installs the committed hooks in .githooks/ into this clone's own hooks
// directory, beside a copy of the conventions checker they run. Runs from the
// root package.json "prepare" script, so `pnpm install` on a fresh clone wires
// the hooks up with no extra step (README "Conventions"). A no-op when there
// is no git checkout or no git on PATH, and it never fails the install: the
// hooks are a convenience for the person committing, CI is the gate.
//
// Why copies: the hooks directory (`git rev-parse --git-common-dir`/hooks,
// shared by every worktree of the clone) sits outside every working tree, so
// no checkout can add a hook or change one, and the hooks run the checker
// copied here rather than the scripts/check-conventions.mjs of whatever branch
// is checked out. The setup before this pointed core.hooksPath at .githooks,
// which made git run the hooks of whatever tree was checked out, an unreviewed
// pull request branch included, so a relative or in-tree hooks path in this
// clone's config is removed. Rerun this script to pick up new hook versions
// (a warm `pnpm install` can skip "prepare").

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS = ['pre-commit', 'commit-msg']
// The installed hooks find the checker here, next to themselves. Every hook
// this script writes names it, so a hook it did not write is left alone.
const CHECKER_DIR = 'boilerindy-conventions'
const CHECKER_FILES = ['check-conventions.mjs', 'lib/conventions.mjs']

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function configValue(args) {
  try {
    return git(['config', ...args, '--get', 'core.hooksPath'])
  } catch {
    return '' // unset
  }
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Writes `content` to `file` unless it already holds exactly that. True when it wrote.
function writeIfChanged(file, content, mode) {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return false
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  if (mode) chmodSync(file, mode)
  return true
}

try {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0)
  const workTree = git(['rev-parse', '--show-toplevel'])

  const local = configValue(['--local'])
  if (local && (!path.isAbsolute(local) || isInside(path.resolve(workTree, local), workTree))) {
    git(['config', '--local', '--unset-all', 'core.hooksPath'])
    console.log(`git hooks: removed core.hooksPath ${local}, which ran the hooks of whatever branch was checked out`)
  }
  const elsewhere = configValue([])
  if (elsewhere) {
    console.log(`git hooks: core.hooksPath is ${elsewhere} in your git config, so git runs hooks from there; the conventions hooks were not installed`)
    process.exit(0)
  }

  const hooksDir = path.join(path.resolve(root, git(['rev-parse', '--git-common-dir'])), 'hooks')
  let changed = false
  for (const file of CHECKER_FILES) {
    changed = writeIfChanged(path.join(hooksDir, CHECKER_DIR, file), readFileSync(path.join(root, 'scripts', file), 'utf8')) || changed
  }
  const skipped = []
  for (const hook of HOOKS) {
    const target = path.join(hooksDir, hook)
    if (existsSync(target) && !readFileSync(target, 'utf8').includes(CHECKER_DIR)) {
      skipped.push(hook)
      continue
    }
    changed = writeIfChanged(target, readFileSync(path.join(root, '.githooks', hook), 'utf8'), 0o755) || changed
  }
  if (changed) console.log(`git hooks: installed ${HOOKS.filter((h) => !skipped.includes(h)).join(' and ')} in ${hooksDir}`)
  for (const hook of skipped) console.log(`git hooks: left your own ${hook} in ${hooksDir} as it is; the conventions ${hook} hook was not installed`)
} catch {
  // Not a checkout, or git is missing (a build host working from an export).
}
