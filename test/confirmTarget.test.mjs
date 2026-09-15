import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { confirmWriteTarget, readSecretFromPrompt, supabaseHost } from '../scripts/lib/confirmTarget.mjs'

const env = { SUPABASE_URL: 'https://abcdefgh.supabase.co' }

// Writable that keeps everything written to it as a string.
function collector() {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      stream.text += chunk.toString()
      callback()
    },
  })
  stream.text = ''
  return stream
}

// Fake stdin. `tty` flips isTTY so the helper takes the interactive branch.
function fakeStdin({ tty = false } = {}) {
  const stdin = new PassThrough()
  if (tty) stdin.isTTY = true
  return stdin
}

// Everything confirmWriteTarget talks to, with exit recorded instead of run.
function harness({ tty = false } = {}) {
  const io = { stdin: fakeStdin({ tty }), stdout: collector(), stderr: collector(), exitCodes: [] }
  io.exit = (code) => io.exitCodes.push(code)
  return io
}

const PROMPT = 'Type the project host to continue:'

// Run `respond` once the prompt is on screen, the way an operator would type.
function whenPrompted(io, respond) {
  const timer = setInterval(() => {
    if (!io.stdout.text.includes(PROMPT)) return
    clearInterval(timer)
    respond()
  }, 1)
}

test('supabaseHost returns the host, or empty for missing and invalid URLs', () => {
  assert.equal(supabaseHost('https://abcdefgh.supabase.co'), 'abcdefgh.supabase.co')
  assert.equal(supabaseHost('http://127.0.0.1:54321/'), '127.0.0.1:54321')
  assert.equal(supabaseHost(undefined), '')
  assert.equal(supabaseHost('not a url'), '')
})

test('--yes prints the host and action and passes without reading stdin', async () => {
  const io = harness()
  const ok = await confirmWriteTarget({ action: 'grant admin to you@gmail.com', yes: true, env, ...io })
  assert.equal(ok, true)
  assert.deepEqual(io.exitCodes, [])
  assert.match(io.stdout.text, /Target Supabase project: abcdefgh\.supabase\.co/)
  assert.match(io.stdout.text, /Action: grant admin to you@gmail\.com/)
  assert.equal(io.stdout.text.includes(PROMPT), false)
})

test('non-TTY stdin without --yes exits 1 after printing the host', async () => {
  const io = harness({ tty: false })
  const ok = await confirmWriteTarget({ action: 'update campaign', env, ...io })
  assert.equal(ok, false)
  assert.deepEqual(io.exitCodes, [1])
  assert.match(io.stdout.text, /Target Supabase project: abcdefgh\.supabase\.co/)
  assert.match(io.stderr.text, /refusing to write without --yes/)
})

test('only a literal true counts as --yes', async () => {
  const io = harness({ tty: false })
  const ok = await confirmWriteTarget({ action: 'update campaign', yes: 'false', env, ...io })
  assert.equal(ok, false)
  assert.deepEqual(io.exitCodes, [1])
})

test('missing or invalid SUPABASE_URL exits 1 even with --yes', async () => {
  for (const badEnv of [{}, { SUPABASE_URL: 'nope' }]) {
    const io = harness()
    const ok = await confirmWriteTarget({ action: 'x', yes: true, env: badEnv, ...io })
    assert.equal(ok, false)
    assert.deepEqual(io.exitCodes, [1])
    assert.match(io.stderr.text, /SUPABASE_URL is missing or not a valid URL/)
    assert.doesNotMatch(io.stdout.text, /Target Supabase project/)
  }
})

test('TTY prompt passes when the typed host matches', async () => {
  const io = harness({ tty: true })
  whenPrompted(io, () => io.stdin.write('  ABCDEFGH.supabase.co \n'))
  const ok = await confirmWriteTarget({ action: 'create advertiser', env, ...io })
  assert.equal(ok, true)
  assert.deepEqual(io.exitCodes, [])
})

test('TTY prompt exits 1 when the typed host does not match', async () => {
  const io = harness({ tty: true })
  whenPrompted(io, () => io.stdin.write('other.supabase.co\n'))
  const ok = await confirmWriteTarget({ action: 'create advertiser', env, ...io })
  assert.equal(ok, false)
  assert.deepEqual(io.exitCodes, [1])
  assert.match(io.stderr.text, /Host did not match; nothing was written/)
})

test('TTY prompt exits 1 when stdin closes without an answer', async () => {
  const io = harness({ tty: true })
  whenPrompted(io, () => io.stdin.end())
  const ok = await confirmWriteTarget({ action: 'create advertiser', env, ...io })
  assert.equal(ok, false)
  assert.deepEqual(io.exitCodes, [1])
  assert.match(io.stderr.text, /No confirmation received/)
})

test('readSecretFromPrompt returns the typed secret without echoing it', async () => {
  for (const tty of [true, false]) {
    const stdin = fakeStdin({ tty })
    const stdout = collector()
    const pending = readSecretFromPrompt('Advertiser password', { stdin, stdout })
    stdin.write('hunter2-long-enough\n')
    assert.equal(await pending, 'hunter2-long-enough')
    assert.match(stdout.text, /^Advertiser password: /)
    assert.doesNotMatch(stdout.text, /hunter2/)
  }
})

test('readSecretFromPrompt returns an empty string when stdin closes', async () => {
  const stdin = fakeStdin()
  const pending = readSecretFromPrompt('Advertiser password', { stdin, stdout: collector() })
  stdin.end()
  assert.equal(await pending, '')
})
