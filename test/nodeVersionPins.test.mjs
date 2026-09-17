import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

// Issue #185. The Node version used to live in four places that disagreed
// (.nvmrc said 20, README and CI said 22, no engines field). The policy now:
//
// - Both .nvmrc files hold a bare major ("22"), never an exact version. CI,
//   `nvm install` and Render (NODE_VERSION=22 in its dashboard, or the root
//   .nvmrc without it) all resolve that to the newest 22.x, so a Node security
//   release needs no commit here. An exact pin (22.22.3) left CI older than
//   the Node Render ran. The cost, which #290's exact pin avoided: `nvm use`
//   picks the newest 22.x already installed, even one below the engines floor
//   (22.22.2), and exits 0 instead of asking for `nvm install`; a pnpm 11
//   installed with npm then fails below 22.13 (the standalone pnpm bundles its
//   own Node and does not), and pnpm only warns on engines up to 22.22.1, while
//   CI stays green. README "Prerequisites" tells developers to run
//   `nvm install` and check `node -v`.
// - Every workflow job that runs Node or pnpm sets up Node once, from the root
//   .nvmrc with check-latest: true, and no workflow hardcodes node-version.
//   Without check-latest, actions/setup-node keeps the newest 22.x cached on the
//   runner image, which trails new releases until GitHub rebuilds the image.
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

// Splits a workflow file into its jobs, and each job into its steps. Job ids sit
// two spaces in under `jobs:`, optionally followed by a comment; a step starts at
// a line whose first token is "- ". Whole-line comments are dropped so a remark
// such as "# uses Node" cannot make a job look like it runs Node.
function workflowJobs(yaml) {
  const body = yaml.replace(/^[ \t]*#.*$/gm, '').split(/^jobs:[ \t]*(?:#.*)?$/m)[1] ?? ''
  return body
    .split(/^(?= {2}[\w-]+:[ \t]*(?:#.*)?$)/m)
    .filter((block) => /^ {2}[\w-]+:/.test(block))
    .map((block) => ({
      id: /^ {2}([\w-]+):/.exec(block)[1],
      steps: block.split(/^(?=[ \t]+- )/m).slice(1),
    }))
}

const isSetupNode = (step) => /^[ \t]+(- )?uses: actions\/setup-node@/m.test(step)
// A job needs Node when a step mentions node, pnpm, npm or npx: a run command,
// pnpm/action-setup, or setup-node itself. A job with none, such as the
// keep-warm curl ping, runs no JavaScript and needs no setup-node step.
const runsNode = (job) => job.steps.some((step) => /\b(node|pnpm|npm|npx)\b/.test(step))
// setup-node reads every input as a string, so a quoted value behaves the same.
const yamlSetting = (key, value) => new RegExp(`^\\s+${key}:[ \\t]*(['"]?)${value}\\1[ \\t]*(?:#.*)?$`, 'm')

const WORKFLOWS = new URL('.github/workflows/', ROOT)
const workflows = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, yaml: readFileSync(new URL(file, WORKFLOWS), 'utf8') }))

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

test('the workflow splitter finds each job, its steps and whether it runs Node', () => {
  const jobs = workflowJobs(
    [
      'on: push',
      'jobs: # all of them',
      '  test:',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '',
      '      # a comment above a step that mentions node',
      '      - uses: actions/setup-node@v7',
      '        with:',
      "          node-version-file: '.nvmrc'",
      '          check-latest: "true" # quoted',
      '  e2e-run: # browser tests',
      '    steps:',
      '      - run: pnpm test',
      '  ping:',
      '    steps:',
      '      # no node here either',
      '      - run: curl -fsS https://example.com/api/health',
      '',
    ].join('\n'),
  )
  assert.deepEqual(
    jobs.map((job) => [job.id, job.steps.length, runsNode(job)]),
    [
      ['test', 2, true],
      ['e2e-run', 1, true],
      ['ping', 1, false],
    ],
  )
  assert.equal(isSetupNode(jobs[0].steps[1]), true)
  assert.match(jobs[0].steps[1], yamlSetting('node-version-file', '\\.nvmrc'))
  assert.match(jobs[0].steps[1], yamlSetting('check-latest', 'true'))
  assert.doesNotMatch("  check-latest: 'true\"", yamlSetting('check-latest', 'true'))
  assert.doesNotMatch('  check-latest: false', yamlSetting('check-latest', 'true'))
})

test('every workflow job that runs Node sets it up from the root .nvmrc and checks for the newest release', () => {
  const ciJobs = workflowJobs(workflows.find(({ file }) => file === 'ci.yml')?.yaml ?? '')
  assert.ok(ciJobs.some(runsNode), 'no job in ci.yml runs Node - the splitter or the path is wrong')
  for (const { file, yaml } of workflows) {
    for (const job of workflowJobs(yaml)) {
      if (!runsNode(job)) continue
      const setup = job.steps.filter(isSetupNode)
      const where = `${file} job "${job.id}"`
      assert.equal(
        setup.length,
        1,
        `${where} runs Node or pnpm, so it needs exactly one actions/setup-node step; without one it runs whatever Node the runner image ships`,
      )
      assert.match(setup[0], yamlSetting('node-version-file', '\\.nvmrc'), `${where} does not read node-version-file: .nvmrc`)
      assert.match(
        setup[0],
        yamlSetting('check-latest', 'true'),
        `${where} lacks check-latest: true, so it would stay on the Node the runner image cached instead of the newest release`,
      )
    }
    assert.doesNotMatch(yaml, /^\s+node-version:/m, `${file} hardcodes node-version; read it from .nvmrc instead`)
  }
})
