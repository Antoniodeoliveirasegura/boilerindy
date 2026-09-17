import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

// Issue #185. The Node version used to live in four places that disagreed
// (.nvmrc said 20, README and CI said 22, no engines field). The policy now:
//
// - Both .nvmrc files hold a bare major ("22"), never an exact version. CI,
//   `nvm install` and Render (NODE_VERSION=22 in its dashboard, or the root
//   .nvmrc without it) all resolve that to the newest 22.x, so a Node security
//   release needs no commit here. An exact pin (22.22.3) left CI older than
//   the Node Render ran. The cost, which #290's exact pin avoided: `nvm use`
//   picks the newest 22.x already installed, even one below the engines floor
//   (22.22.2), and exits 0 instead of asking for `nvm install`; pnpm 11 then
//   fails below 22.13 and only warns from there up to 22.22.1, while CI stays
//   green. README "Prerequisites" tells developers to run `nvm install` and
//   check `node -v`.
// - Every CI job reads the root .nvmrc with check-latest: true. Without it
//   actions/setup-node keeps the newest 22.x cached on the runner image, which
//   trails new releases until GitHub rebuilds the image.
// - Both package.json files declare the same engines.node range, and the
//   .nvmrc major must be one of its majors. Vercel ignores .nvmrc and builds
//   with the newest Node major that boilerindy-react/package.json engines.node
//   allows, overriding the project setting. An open range such as ">=22" would
//   move the production build to every new major as Vercel ships it, so each
//   clause must be a caret range with an upper bound.
//
// See README "Prerequisites" and "Production deployment".

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')

const nvmrc = read('.nvmrc').trim()
const frontendNvmrc = read('boilerindy-react/.nvmrc').trim()
const engines = JSON.parse(read('package.json')).engines?.node
const frontendEngines = JSON.parse(read('boilerindy-react/package.json')).engines?.node

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text)
  return m ? m.slice(1).map(Number) : null
}

// Only "^X.Y.Z || ^X.Y.Z" is accepted: anything else fails here on purpose so
// a new range style gets a deliberate look at what Vercel will do with it.
function parseCaretRange(range) {
  return range.split('||').map((clause) => {
    const m = /^\^(\d+\.\d+\.\d+)$/.exec(clause.trim())
    return m ? parseVersion(m[1]) : null
  })
}

function satisfiesCaret([major, minor, patch], [floorMajor, floorMinor, floorPatch]) {
  if (major !== floorMajor) return false
  if (minor !== floorMinor) return minor > floorMinor
  return patch >= floorPatch
}

// Splits ci.yml into its jobs, and each job into its steps. Job ids sit two
// spaces in under `jobs:`; a step starts at a line whose first token is "- ".
function ciJobs(yaml) {
  const body = yaml.split(/^jobs:\s*$/m)[1] ?? ''
  return body
    .split(/^(?= {2}[\w-]+:[ \t]*$)/m)
    .filter((block) => /^ {2}[\w-]+:/.test(block))
    .map((block) => ({
      id: /^ {2}([\w-]+):/.exec(block)[1],
      steps: block.split(/^(?=[ \t]+- )/m).slice(1),
    }))
}

test('both .nvmrc files hold the same bare Node major', () => {
  assert.match(
    nvmrc,
    /^\d+$/,
    `.nvmrc must hold a bare major such as 22, found "${nvmrc}"; an exact version stops CI and nvm from following new Node releases`,
  )
  assert.equal(frontendNvmrc, nvmrc, 'boilerindy-react/.nvmrc and the root .nvmrc disagree')
})

test('no .node-version or .tool-versions file competes with .nvmrc', () => {
  // Render reads .node-version before .nvmrc, and asdf or mise read
  // .tool-versions, so a stray one would quietly move a runtime off the major.
  for (const dir of ['', 'boilerindy-react/']) {
    for (const file of ['.node-version', '.tool-versions']) {
      assert.equal(existsSync(new URL(dir + file, ROOT)), false, `${dir}${file} exists; keep the Node version in .nvmrc only`)
    }
  }
})

test('both package.json files declare the same engines.node range', () => {
  assert.equal(typeof engines, 'string', 'package.json is missing engines.node')
  assert.equal(frontendEngines, engines, 'boilerindy-react/package.json engines.node differs from the root')
})

test('every engines.node clause is a caret range, so Vercel cannot drift to a new major', () => {
  const clauses = parseCaretRange(engines)
  assert.ok(
    clauses.every(Boolean),
    `engines.node "${engines}" must be "^X.Y.Z" clauses joined by "||"; an open range moves the Vercel build to each new Node major`,
  )
})

test('engines.node allows the .nvmrc major', () => {
  const majors = parseCaretRange(engines)
    .filter(Boolean)
    .map(([major]) => major)
  assert.ok(majors.includes(Number(nvmrc)), `.nvmrc major ${nvmrc} has no clause in engines.node "${engines}"`)
})

test('the caret matcher follows semver for the ranges used here', () => {
  const range = parseCaretRange('^22.22.2 || ^24.15.0')
  const ok = (v) => range.some((floor) => satisfiesCaret(parseVersion(v), floor))
  assert.equal(ok('22.22.2'), true)
  assert.equal(ok('22.23.0'), true)
  assert.equal(ok('24.15.0'), true)
  assert.equal(ok('22.22.1'), false)
  assert.equal(ok('22.9.9'), false)
  assert.equal(ok('24.14.9'), false)
  assert.equal(ok('26.0.0'), false)
  assert.deepEqual(parseCaretRange('>=22 || ^24.15.0'), [null, [24, 15, 0]])
})

test('the ci.yml splitter finds each job and its setup-node step', () => {
  const jobs = ciJobs(
    [
      'on: push',
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '',
      '      # a comment above a step',
      '      - uses: actions/setup-node@v7',
      '        with:',
      '          node-version-file: .nvmrc',
      '  e2e-run:',
      '    steps:',
      '      - run: pnpm test',
      '',
    ].join('\n'),
  )
  assert.deepEqual(
    jobs.map(({ id, steps }) => [id, steps.length]),
    [
      ['test', 2],
      ['e2e-run', 1],
    ],
  )
  assert.match(jobs[0].steps[1], /node-version-file: \.nvmrc/)
})

test('every CI job sets up Node from the root .nvmrc and checks for the newest release', () => {
  const ci = read('.github/workflows/ci.yml')
  const jobs = ciJobs(ci)
  assert.ok(jobs.length > 0, 'no jobs found in ci.yml - the pattern or the path is wrong')
  for (const { id, steps } of jobs) {
    const setup = steps.filter((step) => /^[ \t]+(- )?uses: actions\/setup-node@/m.test(step))
    assert.equal(
      setup.length,
      1,
      `CI job "${id}" needs exactly one actions/setup-node step; without one it runs whatever Node the runner image ships`,
    )
    assert.match(setup[0], /^\s+node-version-file: \.nvmrc\s*$/m, `CI job "${id}" does not read node-version-file: .nvmrc`)
    assert.match(
      setup[0],
      /^\s+check-latest: true\s*$/m,
      `CI job "${id}" lacks check-latest: true, so it would stay on the Node the runner image cached instead of the newest release`,
    )
  }
  assert.doesNotMatch(ci, /^\s+node-version:/m, 'ci.yml hardcodes node-version; read it from .nvmrc instead')
})
