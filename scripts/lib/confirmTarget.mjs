// Guard rails shared by the admin scripts that write to Supabase (issue #211).
// The root .env normally points at the single production project, so every
// writing script names the target host and waits for an explicit go-ahead:
// either --yes, or the operator typing the host back at a terminal prompt.
//
// stdin/stdout/stderr/exit are injectable so test/confirmTarget.test.mjs can
// drive the prompt with fake streams; the scripts use the process defaults.

import readline from 'node:readline/promises'
import { Writable } from 'node:stream'

/** Host of a Supabase project URL (`abc.supabase.co`), or '' when missing or invalid. */
export function supabaseHost(url) {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// rl.question() never settles when the input closes (Ctrl+C, Ctrl+D, empty
// pipe), so treat a close as "no answer" instead of hanging the script. A piped
// last line without a trailing newline reaches readline only as a plain 'line'
// event at end of input, never the question callback, so take that too.
function ask(rl, query) {
  return new Promise((resolve) => {
    rl.once('line', resolve)
    rl.once('close', () => resolve(null))
    rl.question(query).then(resolve, () => resolve(null))
  })
}

/**
 * Print the target project and the action, then require confirmation before a
 * write. Returns true when the caller may write. Otherwise prints the reason to
 * stderr, calls exit(1) and returns false (only observable with an injected exit).
 */
export async function confirmWriteTarget({
  action,
  yes = false,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
} = {}) {
  const refuse = (message) => {
    stderr.write(`${message}\n`)
    exit(1)
    return false
  }

  const host = supabaseHost(env.SUPABASE_URL)
  if (!host) return refuse('ERROR: SUPABASE_URL is missing or not a valid URL; nothing was written.')

  stdout.write(`Target Supabase project: ${host}\n`)
  if (action) stdout.write(`Action: ${action}\n`)
  if (yes === true) return true

  if (!stdin.isTTY) {
    return refuse('ERROR: stdin is not a terminal; refusing to write without --yes.')
  }

  const rl = readline.createInterface({ input: stdin, output: stdout })
  const answer = await ask(rl, 'Type the project host to continue: ')
  rl.close()
  if (answer === null) return refuse('\nNo confirmation received; nothing was written.')
  if (answer.trim().toLowerCase() !== host) return refuse('Host did not match; nothing was written.')
  return true
}

/**
 * Read a secret (e.g. a password) from stdin without echoing it. Works at a
 * terminal and with piped input; returns '' when stdin closes without a line.
 */
export async function readSecretFromPrompt(label, { stdin = process.stdin, stdout = process.stdout } = {}) {
  // readline echoes keystrokes through its output stream, so give it a sink
  // that drops everything and write the label and trailing newline ourselves.
  // At a terminal readline also switches stdin to raw mode, which stops the
  // tty's own echo.
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const rl = readline.createInterface({ input: stdin, output: muted, terminal: Boolean(stdin.isTTY) })
  stdout.write(`${label}: `)
  const answer = await ask(rl, '')
  rl.close()
  stdout.write('\n')
  return answer ?? ''
}
