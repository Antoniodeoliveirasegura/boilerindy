import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'node:util'
import express from 'express'
import { createPurdueEmailRouter } from '../../src/routes/purdueEmail.mjs'
import { hashCode, LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE } from '../../src/purdueEmailVerification.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #181: the Purdue email-code routes as a feature router, booted on a
// small app with a fake session, a recording limiter, a fake mailer, a fake
// linkPurdueIdentity and an in-memory purdue_email_challenges table, the way
// server.mjs mounts it with the real ones.

const USER_ID = '11111111-1111-4111-8111-111111111111'
const EMAIL = 'jdoe@purdue.edu'
const EXPIRED = 'That code has expired. Request a new one.'
const UNSENT = 'We could not send the code right now. Please try again in a few minutes.'
const NO_CODE = 'Request a code first.'
const WRONG = 'That code is not right.'

const ROUTES = [
  ['POST', '/api/me/purdue-email/request', { email: EMAIL }],
  ['POST', '/api/me/purdue-email/verify', { code: '123456' }],
  ['GET', '/api/me/purdue-email/status'],
]

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString()
const minutesAhead = (m) => new Date(Date.now() + m * 60 * 1000).toISOString()

/** A stored challenge whose code is `code`, created `age` minutes ago. */
function storedChallenge({ id = '22222222-2222-4222-8222-222222222222', code = '123456', age = 2, ...rest } = {}) {
  return {
    id,
    user_id: USER_ID,
    email: EMAIL,
    code_hash: hashCode(id, code),
    expires_at: minutesAhead(10 - age),
    attempts: 0,
    consumed_at: null,
    created_at: minutesAgo(age),
    ...rest,
  }
}

// purdue_email_challenges, interpreting the recorded chain against `db.rows`:
// eq / is filters, newest-first order and limit, insert, conditional update
// (answering the matched ids when the chain selects them) and delete.
// `db.beforeUpdate(chain)` runs first, to stage a race.
function challengesTable(db) {
  return (chain) => {
    if (db.error) return { data: null, error: db.error }
    const filters = chain.filter((c) => c.method === 'eq' || c.method === 'is')
    const matches = (row) =>
      filters.every(({ method, args: [column, value] }) => (method === 'is' ? (row[column] ?? null) === value : row[column] === value))
    const op = operation(chain)
    if (op === 'insert') {
      db.rows.push({ ...chain.find((c) => c.method === 'insert').args[0] })
      return { data: null, error: null }
    }
    if (op === 'delete') {
      db.rows = db.rows.filter((row) => !matches(row))
      return { data: null, error: null }
    }
    if (op === 'update') {
      db.beforeUpdate?.(chain)
      const hit = db.rows.filter(matches)
      for (const row of hit) Object.assign(row, chain.find((c) => c.method === 'update').args[0])
      return { data: hasCall(chain, 'select') ? hit.map((row) => ({ id: row.id })) : null, error: null }
    }
    let rows = db.rows.filter(matches)
    if (hasCall(chain, 'order', 'created_at', { ascending: false })) {
      rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
    }
    const limit = chain.find((c) => c.method === 'limit')
    if (limit) rows = rows.slice(0, limit.args[0])
    if (hasCall(chain, 'maybeSingle')) return { data: rows[0] ?? null, error: null }
    return { data: rows.map((row) => ({ ...row })), error: null }
  }
}

async function withApp(options, run) {
  const {
    user = { id: USER_ID, email: 'jdoe@gmail.com', purdue_email: null },
    rows = [],
    isProduction = false,
    send = async () => ({ sent: true, id: 'resend-1' }),
    link = async (_userId, { email }) => ({ id: USER_ID, purdue_email: email }),
    signedIn = true,
    tableError = null,
  } = options
  const db = { rows: rows.map((row) => ({ ...row })), error: tableError, beforeUpdate: null }
  const supabase = fakeSupabase({ purdue_email_challenges: challengesTable(db) })
  const limiterHits = []
  const mail = []
  const links = []
  const app = express()
  app.use(express.json())
  app.use(
    createPurdueEmailRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!signedIn) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = { ...user }
        next()
      },
      purdueVerifyRateLimit: (req, _res, next) => {
        limiterHits.push(`purdueVerifyRateLimit ${req.method} ${req.path}`)
        next()
      },
      linkPurdueIdentity: async (userId, args) => {
        links.push({ userId, ...args })
        const linked = await link(userId, args)
        user.purdue_email = linked?.purdue_email ?? user.purdue_email
        return linked
      },
      sendEmail: async (message) => {
        mail.push(message)
        return send(message)
      },
      isProduction,
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, headers: response.headers, text, body: JSON.parse(text) }
  }
  try {
    await run({ call, db, supabase, limiterHits, mail, links, user })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** The six digits in a sent verification email. */
function codeIn(message) {
  const match = /(\d{6})</.exec(message.html)
  assert.ok(match, 'the email carries a six-digit code')
  return match[1]
}

/** Every console line the block writes, while it runs; the block sees them as they come. */
async function captureConsole(block) {
  const lines = []
  const saved = { log: console.log, warn: console.warn, error: console.error }
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(format(...args))
  try {
    await block(lines)
  } finally {
    Object.assign(console, saved)
  }
  return lines
}

const writesTo = (supabase, op) => supabase.queriesOf('purdue_email_challenges').filter((q) => operation(q.chain) === op)

test('every route sits behind requireAuth', async () => {
  await withApp({ signedIn: false }, async ({ call, supabase, mail, links }) => {
    for (const [method, path, body] of ROUTES) {
      const answer = await call(method, path, body)
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.equal(mail.length, 0)
    assert.equal(links.length, 0)
  })
})

test('the two writes pass purdue-verify under the server.mjs name, status does not', async () => {
  await withApp({}, async ({ call, limiterHits }) => {
    for (const [method, path, body] of ROUTES) await call(method, path, body)
    assert.deepEqual(limiterHits, ['purdueVerifyRateLimit POST /api/me/purdue-email/request', 'purdueVerifyRateLimit POST /api/me/purdue-email/verify'])
  })
})

test('the full lifecycle: request, pending status, verify, linked status', async () => {
  await withApp({}, async ({ call, db, mail, links }) => {
    const requested = await call('POST', '/api/me/purdue-email/request', { email: '  JDoe@Purdue.edu ' })
    assert.equal(requested.status, 200)
    assert.deepEqual(Object.keys(requested.body).sort(), ['cooldownSeconds', 'email', 'expiresAt', 'ok'])
    assert.equal(requested.body.email, EMAIL)
    assert.equal(requested.body.cooldownSeconds, 60)
    const ttl = Date.parse(requested.body.expiresAt) - Date.now()
    assert.ok(ttl > 9 * 60 * 1000 && ttl <= 10 * 60 * 1000, 'the code lives ten minutes')

    // Mailed to the address being verified, not the login email.
    assert.equal(mail.length, 1)
    assert.equal(mail[0].to, EMAIL)
    assert.equal(mail[0].subject, 'Your BoilerIndy verification code')
    const code = codeIn(mail[0])
    assert.ok(!requested.text.includes(code), 'the answer never carries the code')

    // One row, holding the hash over its own id, never the code.
    assert.equal(db.rows.length, 1)
    const [row] = db.rows
    assert.equal(row.user_id, USER_ID)
    assert.equal(row.email, EMAIL)
    assert.equal(row.code_hash, hashCode(row.id, code))
    assert.ok(!JSON.stringify(row).includes(code))

    const pending = await call('GET', '/api/me/purdue-email/status')
    assert.deepEqual(pending.body, {
      linked: false,
      purdueEmail: null,
      pending: { email: EMAIL, expiresAt: requested.body.expiresAt, attemptsLeft: 5 },
    })

    const verified = await call('POST', '/api/me/purdue-email/verify', { code: `${code.slice(0, 3)} ${code.slice(3)}` })
    assert.equal(verified.status, 200)
    assert.deepEqual(verified.body, { ok: true, purdueEmail: EMAIL })
    assert.deepEqual(links, [{ userId: USER_ID, email: EMAIL }])
    assert.ok(db.rows[0].consumed_at, 'the code is spent')

    const linked = await call('GET', '/api/me/purdue-email/status')
    assert.deepEqual(linked.body, { linked: true, purdueEmail: EMAIL, pending: null })

    // A spent code cannot be used twice.
    const again = await call('POST', '/api/me/purdue-email/verify', { code })
    assert.deepEqual(again.body, { error: { message: NO_CODE, status: 400 } })
    assert.equal(links.length, 1)
  })
})

test('request refuses anything but an exact @purdue.edu address, before any read', async () => {
  await withApp({}, async ({ call, supabase, mail }) => {
    for (const email of ['jdoe@cs.purdue.edu', 'jdoe+x@purdue.edu', 'jdoe@gmail.com', '', undefined, 42]) {
      const answer = await call('POST', '/api/me/purdue-email/request', email === undefined ? {} : { email })
      assert.equal(answer.status, 400, String(email))
      assert.deepEqual(answer.body, { error: { message: 'Use your @purdue.edu address.', status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)
    assert.equal(mail.length, 0)
  })
})

test('request answers alreadyLinked for the address the profile already holds', async () => {
  await withApp({ user: { id: USER_ID, purdue_email: EMAIL } }, async ({ call, supabase, mail }) => {
    const answer = await call('POST', '/api/me/purdue-email/request', { email: 'JDOE@purdue.edu' })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true, alreadyLinked: true })
    assert.equal(supabase.queries.length, 0)
    assert.equal(mail.length, 0)
  })
})

test('request refuses a second address with linkPurdueIdentity\'s own message', async () => {
  await withApp({ user: { id: USER_ID, purdue_email: 'other@purdue.edu' } }, async ({ call, supabase, mail }) => {
    const answer = await call('POST', '/api/me/purdue-email/request', { email: EMAIL })
    assert.equal(answer.status, 400)
    assert.deepEqual(answer.body, { error: { message: LINKED_TO_ANOTHER_PURDUE_ACCOUNT_MESSAGE, status: 400 } })
    assert.equal(supabase.queries.length, 0)
    assert.equal(mail.length, 0)
  })
})

test('a second request inside a minute answers 429 with Retry-After, spent or not', async () => {
  for (const consumed_at of [null, minutesAgo(0)]) {
    await withApp({ rows: [storedChallenge({ age: 0.5, consumed_at })] }, async ({ call, db, mail }) => {
      const answer = await call('POST', '/api/me/purdue-email/request', { email: EMAIL })
      assert.equal(answer.status, 429)
      const wait = answer.body.error.retryAfterSeconds
      assert.ok(wait > 0 && wait <= 30, `waits out the rest of the minute, got ${wait}`)
      assert.deepEqual(answer.body, {
        error: { message: 'Please wait a minute before requesting another code.', status: 429, retryAfterSeconds: wait },
      })
      assert.equal(answer.headers.get('retry-after'), String(wait))
      assert.equal(db.rows.length, 1, 'nothing deleted')
      assert.equal(mail.length, 0)
    })
  }
})

test('a new request deletes the old code, so only the newest one verifies', async () => {
  const old = storedChallenge({ code: '111111', age: 3 })
  await withApp({ rows: [old] }, async ({ call, db, supabase, mail }) => {
    const answer = await call('POST', '/api/me/purdue-email/request', { email: EMAIL })
    assert.equal(answer.status, 200)
    const [clear] = writesTo(supabase, 'delete')
    assert.ok(hasCall(clear.chain, 'eq', 'user_id', USER_ID))
    assert.equal(db.rows.length, 1)
    assert.notEqual(db.rows[0].id, old.id)

    const stale = await call('POST', '/api/me/purdue-email/verify', { code: '111111' })
    assert.deepEqual(stale.body, { error: { message: WRONG, status: 400 } })
    const fresh = await call('POST', '/api/me/purdue-email/verify', { code: codeIn(mail[0]) })
    assert.equal(fresh.status, 200)
  })
})

test('verify wants six digits, before any read', async () => {
  await withApp({ rows: [storedChallenge()] }, async ({ call, supabase }) => {
    for (const code of ['12345', '1234567', 'abcdef', '', undefined]) {
      const answer = await call('POST', '/api/me/purdue-email/verify', code === undefined ? {} : { code })
      assert.deepEqual(answer.body, { error: { message: 'Enter the 6-digit code.', status: 400 } }, String(code))
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('verify with no challenge, or a spent one, asks for a code first', async () => {
  await withApp({}, async ({ call, links }) => {
    const answer = await call('POST', '/api/me/purdue-email/verify', { code: '123456' })
    assert.equal(answer.status, 400)
    assert.deepEqual(answer.body, { error: { message: NO_CODE, status: 400 } })
    assert.equal(links.length, 0)
  })
  await withApp({ rows: [storedChallenge({ consumed_at: minutesAgo(1) })] }, async ({ call, links }) => {
    const answer = await call('POST', '/api/me/purdue-email/verify', { code: '123456' })
    assert.deepEqual(answer.body, { error: { message: NO_CODE, status: 400 } })
    assert.equal(links.length, 0)
  })
})

test('a wrong code counts against the challenge, and five use it up', async () => {
  await withApp({ rows: [storedChallenge()] }, async ({ call, db, supabase, links }) => {
    for (let i = 1; i <= 5; i += 1) {
      const answer = await call('POST', '/api/me/purdue-email/verify', { code: '000000' })
      assert.deepEqual(answer.body, { error: { message: WRONG, status: 400 } })
      assert.equal(db.rows[0].attempts, i)
    }
    // Every count was conditional on the value it read.
    const counts = writesTo(supabase, 'update')
    assert.equal(counts.length, 5)
    counts.forEach((q, i) => assert.ok(hasCall(q.chain, 'eq', 'attempts', i), `count ${i + 1} is conditional`))

    const status = await call('GET', '/api/me/purdue-email/status')
    assert.equal(status.body.pending.attemptsLeft, 0)
    // Exhausted: even the right code is refused now, and nothing more is counted.
    const right = await call('POST', '/api/me/purdue-email/verify', { code: '123456' })
    assert.deepEqual(right.body, { error: { message: EXPIRED, status: 400 } })
    assert.equal(db.rows[0].attempts, 5)
    assert.equal(links.length, 0)
  })
})

test('two wrong codes in flight are both counted: the loser reads the count again', async () => {
  await withApp({ rows: [storedChallenge({ attempts: 1 })] }, async ({ call, db, supabase }) => {
    // Another wrong code lands between this request's read and its count.
    let raced = false
    db.beforeUpdate = () => {
      if (raced) return
      raced = true
      db.rows[0].attempts = 2
    }
    const answer = await call('POST', '/api/me/purdue-email/verify', { code: '000000' })
    assert.deepEqual(answer.body, { error: { message: WRONG, status: 400 } })
    assert.equal(db.rows[0].attempts, 3)
    const counts = writesTo(supabase, 'update')
    assert.ok(hasCall(counts[0].chain, 'eq', 'attempts', 1))
    assert.ok(hasCall(counts[1].chain, 'eq', 'attempts', 2))
  })
})

test('an expired code is refused and not counted, even when it is right', async () => {
  await withApp({ rows: [storedChallenge({ age: 11, expires_at: minutesAgo(1) })] }, async ({ call, db, links }) => {
    const answer = await call('POST', '/api/me/purdue-email/verify', { code: '123456' })
    assert.deepEqual(answer.body, { error: { message: EXPIRED, status: 400 } })
    assert.equal(db.rows[0].attempts, 0)
    assert.equal(links.length, 0)
    const status = await call('GET', '/api/me/purdue-email/status')
    assert.equal(status.body.pending, null)
  })
})

test('a failed send removes the code, answers 503, and leaves no cooldown behind', async () => {
  const lines = await captureConsole(async () => {
    await withApp({ send: async () => { throw new Error('Resend send failed (500): boom') } }, async ({ call, db, mail }) => {
      const answer = await call('POST', '/api/me/purdue-email/request', { email: EMAIL })
      assert.equal(answer.status, 503)
      assert.deepEqual(answer.body, { error: { message: UNSENT, status: 503 } })
      assert.equal(db.rows.length, 0)
      const retry = await call('POST', '/api/me/purdue-email/request', { email: EMAIL })
      assert.equal(retry.status, 503, 'no 429: an unsent code starts no cooldown')
      assert.equal(mail.length, 2)
    })
  })
  assert.ok(lines.includes('[purdue-email] could not send a code to j***@purdue.edu: Resend send failed (500): boom'), 'logged with a masked address')
  assert.ok(!lines.some((line) => line.includes(EMAIL)), 'never the full address')
})

test('with email off, production refuses to pretend a code went out', async () => {
  const lines = await captureConsole(async (lines) => {
    await withApp({ isProduction: true, send: async () => ({ sent: false, skipped: true }) }, async ({ call, db, mail }) => {
      const answer = await call('POST', '/api/me/purdue-email/request', { email: EMAIL })
      assert.equal(answer.status, 503)
      assert.deepEqual(answer.body, { error: { message: UNSENT, status: 503 } })
      assert.equal(db.rows.length, 0)
      const code = codeIn(mail[0])
      assert.ok(!lines.some((line) => line.includes(code)), 'no code in the production log')
    })
  })
  assert.ok(lines.some((line) => line.includes('RESEND_API_KEY')))
})

test('with email off in development, the code is logged for local work and the request succeeds', async () => {
  await captureConsole(async (lines) => {
    await withApp({ send: async () => ({ sent: false, skipped: true }) }, async ({ call, db, mail }) => {
      const answer = await call('POST', '/api/me/purdue-email/request', { email: EMAIL })
      assert.equal(answer.status, 200)
      assert.equal(db.rows.length, 1)
      const code = codeIn(mail[0])
      assert.ok(lines.includes(`[purdue-email] dev code for j***@purdue.edu: ${code}`))
    })
  })
})

test('when another right answer spends the code first, this one links nothing', async () => {
  await withApp({ rows: [storedChallenge()] }, async ({ call, db, links }) => {
    db.beforeUpdate = () => {
      db.rows[0].consumed_at = new Date().toISOString()
    }
    const answer = await call('POST', '/api/me/purdue-email/verify', { code: '123456' })
    assert.deepEqual(answer.body, { error: { message: EXPIRED, status: 400 } })
    assert.equal(links.length, 0)
  })
})

test('a refused link answers 400 with its own message and writes nothing more', async () => {
  const held = 'That Purdue account is already linked to another BoilerIndy profile. Sign in with the email you used before, or contact support to release the link.'
  await withApp(
    { rows: [storedChallenge()], link: async () => { throw new Error(held) } },
    async ({ call, supabase, links }) => {
      const answer = await call('POST', '/api/me/purdue-email/verify', { code: '123456' })
      assert.equal(answer.status, 400)
      assert.deepEqual(answer.body, { error: { message: held, status: 400 } })
      assert.equal(links.length, 1)
      // The consume, and nothing after it.
      assert.equal(writesTo(supabase, 'update').length, 1)
      assert.equal(writesTo(supabase, 'insert').length + writesTo(supabase, 'delete').length, 0)
    },
  )
})

test('status: nothing requested, a live code, a spent one, and a linked profile', async () => {
  await withApp({}, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/me/purdue-email/status')).body, { linked: false, purdueEmail: null, pending: null })
  })
  const live = storedChallenge({ attempts: 2 })
  await withApp({ rows: [live] }, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/me/purdue-email/status')).body, {
      linked: false,
      purdueEmail: null,
      pending: { email: EMAIL, expiresAt: new Date(live.expires_at).toISOString(), attemptsLeft: 3 },
    })
  })
  await withApp({ rows: [storedChallenge({ consumed_at: minutesAgo(1) })], user: { id: USER_ID, purdue_email: EMAIL } }, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/me/purdue-email/status')).body, { linked: true, purdueEmail: EMAIL, pending: null })
  })
})

test('every route answers purdue_email_verification_schema_missing before the table exists', async () => {
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.purdue_email_challenges' in the schema cache" }
  await captureConsole(async () => {
    await withApp({ tableError: missing }, async ({ call, mail, links }) => {
      for (const [method, path, body] of ROUTES) {
        const answer = await call(method, path, body)
        assert.equal(answer.status, 503, `${method} ${path}`)
        assert.deepEqual(answer.body, {
          error: {
            message: 'Purdue email verification is not set up yet. Please try again later.',
            code: 'purdue_email_verification_schema_missing',
            status: 503,
          },
        })
      }
      assert.equal(mail.length, 0)
      assert.equal(links.length, 0)
    })
  })
})

test('any other database failure answers 500 with the feature message', async () => {
  await captureConsole(async () => {
    await withApp({ tableError: { code: 'XX000', message: 'boom' } }, async ({ call }) => {
      const answer = await call('POST', '/api/me/purdue-email/request', { email: EMAIL })
      assert.equal(answer.status, 500)
      assert.deepEqual(answer.body, { error: { message: 'Could not start verification. Please try again.', status: 500 } })
    })
  })
})
