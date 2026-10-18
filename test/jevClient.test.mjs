import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JEV_API_URL, JevError, createJevClient, retryDelayMs } from '../src/jevClient.mjs'

// Issue #30: the TypeSafe Jev wire format (https://docs.typesafe.ai/api),
// checked with an injected fetch and no real key. Retries: TypeSafe asks for
// backoff on 429 and 529; our own request errors fail at once.

const KEY = 'ts-test-key'
const QUESTIONS = { free_food: { type: 'noul', instructions: 'Attendees are offered food or drinks at no cost at this event.' } }
const ANSWER = { model: 'jev-1.13.0', answers: { free_food: { type: 'noul', noul: 0.96 } }, usage: { input_tokens: 293, output_tokens: 21 } }

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function recordingFetch(answers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next() : next
  }
  return { calls, fetchImpl }
}

const noSleep = async () => {}

test('evaluate posts state, the pinned model and the questions with the key as a bearer token', async () => {
  const { calls, fetchImpl } = recordingFetch([json(ANSWER)])
  const jev = createJevClient({ apiKey: KEY, model: 'jev-1.13.0', fetchImpl, sleep: noSleep })
  const out = await jev.evaluate({ title: 'Honors House Coffee' }, QUESTIONS)

  assert.deepEqual(out, { model: 'jev-1.13.0', answers: ANSWER.answers, usage: ANSWER.usage })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, JEV_API_URL)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`)
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: { title: 'Honors House Coffee' }, model: 'jev-1.13.0', questions: QUESTIONS })
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'every call has a deadline')
  assert.equal(jev.model, 'jev-1.13.0')
})

test('429 and 529 are retried with backoff, honoring retry-after; a 5xx and a network error too', async () => {
  const waits = []
  const sleep = async (ms) => {
    waits.push(ms)
  }
  const { calls, fetchImpl } = recordingFetch([
    json({ error: 'rate limited' }, 429, { 'retry-after': '2' }),
    json({ error: 'overloaded' }, 529),
    new TypeError('fetch failed'),
    json(ANSWER),
  ])
  const jev = createJevClient({ apiKey: KEY, model: 'jev-1.13.0', fetchImpl, sleep, random: () => 1 })
  const out = await jev.evaluate('state', QUESTIONS)
  assert.equal(out.answers.free_food.noul, 0.96)
  assert.equal(calls.length, 4)
  assert.deepEqual(waits, [2000, 1000, 2000]) // retry-after 2 s, then 0.5 s doubling: 1 s, 2 s

  const { fetchImpl: failing } = recordingFetch([json({ error: 'bad gateway' }, 502)])
  const tired = createJevClient({ apiKey: KEY, model: 'jev-1.13.0', fetchImpl: failing, sleep: noSleep, maxRetries: 2 })
  await assert.rejects(tired.evaluate('state', QUESTIONS), (error) => {
    assert.ok(error instanceof JevError)
    assert.equal(error.status, 502)
    assert.equal(error.fatal, false)
    return true
  })
})

test('our own request errors fail at once and are fatal; the key never reaches the error', async () => {
  for (const status of [400, 401, 403, 422]) {
    const { calls, fetchImpl } = recordingFetch([json({ error: { message: 'no' } }, status)])
    const jev = createJevClient({ apiKey: KEY, model: 'jev-1.13.0', fetchImpl, sleep: noSleep })
    await assert.rejects(jev.evaluate('state', QUESTIONS), (error) => {
      assert.ok(error instanceof JevError)
      assert.equal(error.status, status)
      assert.equal(error.fatal, true)
      assert.match(error.message, new RegExp(`Jev responded ${status}`))
      assert.ok(!error.message.includes(KEY))
      return true
    })
    assert.equal(calls.length, 1, `${status} is not retried`)
  }
})

test('a timeout, a body that is not JSON, or one without answers is a JevError', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  const { fetchImpl: slow } = recordingFetch([timeout])
  await assert.rejects(createJevClient({ apiKey: KEY, model: 'm', fetchImpl: slow, sleep: noSleep, maxRetries: 0 }).evaluate('s', QUESTIONS), /Jev timed out/)

  const { fetchImpl: html } = recordingFetch([new Response('<html>oops</html>', { status: 200 })])
  await assert.rejects(createJevClient({ apiKey: KEY, model: 'm', fetchImpl: html, sleep: noSleep }).evaluate('s', QUESTIONS), /other than JSON/)

  const { fetchImpl: empty } = recordingFetch([json({ model: 'm' })])
  await assert.rejects(createJevClient({ apiKey: KEY, model: 'm', fetchImpl: empty, sleep: noSleep }).evaluate('s', QUESTIONS), /without answers/)
})

test('retryDelayMs: retry-after in seconds up to 10 s, else 0.5 s doubling with jitter', () => {
  assert.equal(retryDelayMs(0, '3'), 3000)
  assert.equal(retryDelayMs(0, '60'), 10_000)
  assert.equal(retryDelayMs(0, '0'), 0)
  assert.equal(retryDelayMs(2, null, () => 1), 2000)
  assert.equal(retryDelayMs(2, null, () => 0), 1000)
  assert.equal(retryDelayMs(1, 'soon', () => 1), 1000)
})

test('a client needs a key and a model', () => {
  assert.throws(() => createJevClient({ model: 'jev-1.13.0' }), /API key/)
  assert.throws(() => createJevClient({ apiKey: KEY }), /model id/)
})
