import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GROQ_FALLBACK_MODEL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_REASONING_EFFORT,
  GROQ_CHAT_URL,
  GroqUpstreamError,
  buildGroqRequest,
  createGroqClient,
  extractGroqText,
  resolveReasoningEffort,
} from '../src/groqClient.mjs'

// Grok -> Groq swap (2026-09-14): the chat-completions wire format lives in
// src/groqClient.mjs so it can be checked here without booting server.mjs or
// holding a real key.

test('buildGroqRequest puts the system prompt first, keeps user/assistant turns only', () => {
  const body = buildGroqRequest({
    system: 'You are BoilerIndy.',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', content: 'dropped' },
      null,
      { role: 'user', content: 42 },
    ],
    maxOutputTokens: 60,
    temperature: 0.1,
  })
  assert.equal(body.model, DEFAULT_GROQ_MODEL)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are BoilerIndy.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: '42' },
  ])
  assert.equal(body.max_completion_tokens, 60)
  assert.equal(body.temperature, 0.1)
  assert.equal('max_tokens' in body, false, 'max_tokens is the deprecated name')
  assert.equal('input' in body, false, 'no Responses-API leftovers')
  assert.equal('store' in body, false)
  // The default model is a gpt-oss reasoning model: low effort keeps replies quick.
  assert.equal(body.reasoning_effort, DEFAULT_REASONING_EFFORT)
})

test('reasoning effort: explicit wins, gpt-oss defaults to low, other models send none', () => {
  assert.equal(resolveReasoningEffort('openai/gpt-oss-120b', undefined), 'low')
  assert.equal(resolveReasoningEffort('openai/gpt-oss-20b', 'high'), 'high')
  assert.equal(resolveReasoningEffort('qwen/qwen3.6-27b', undefined), undefined)
  assert.equal(resolveReasoningEffort('qwen/qwen3.6-27b', 'none'), 'none')

  const body = buildGroqRequest({ model: 'qwen/qwen3.6-27b', messages: [{ role: 'user', content: 'tag this' }] })
  assert.equal(body.model, 'qwen/qwen3.6-27b')
  assert.deepEqual(body.messages, [{ role: 'user', content: 'tag this' }])
  assert.equal('reasoning_effort' in body, false)
  assert.equal('max_completion_tokens' in body, false)
  assert.equal('temperature' in body, false)
})

test('extractGroqText returns the first choice content and ignores reasoning', () => {
  const data = {
    choices: [
      { index: 0, message: { role: 'assistant', reasoning: 'thinking...', content: 'Your next class is at 2pm.' }, finish_reason: 'stop' },
    ],
  }
  assert.equal(extractGroqText(data), 'Your next class is at 2pm.')
  assert.equal(
    extractGroqText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }),
    'ab',
  )
})

test('extractGroqText returns null when there is no text (empty, refusal, malformed)', () => {
  assert.equal(extractGroqText({ choices: [] }), null)
  assert.equal(extractGroqText({ choices: [{ message: { role: 'assistant', content: '', refusal: 'no' } }] }), null)
  assert.equal(extractGroqText({ choices: [{ message: { role: 'assistant', content: null } }] }), null)
  assert.equal(extractGroqText({}), null)
  assert.equal(extractGroqText(null), null)
})

test('createGroqClient.reply posts a bearer-authed chat request and returns the text', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: '["parking"]' } }] }),
      text: async () => '',
    }
  }
  const ai = createGroqClient({ apiKey: 'gsk_testkey', model: 'openai/gpt-oss-120b', fetchImpl })
  assert.equal(ai.enabled, true)
  assert.equal(ai.model, 'openai/gpt-oss-120b')

  const text = await ai.reply({
    system: 'tagger',
    messages: [{ role: 'user', content: 'Where do I park near ET?' }],
    maxOutputTokens: 60,
    temperature: 0.1,
  })
  assert.equal(text, '["parking"]')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, GROQ_CHAT_URL)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gsk_testkey')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.model, 'openai/gpt-oss-120b')
  assert.equal(sent.max_completion_tokens, 60)
  assert.equal(sent.reasoning_effort, 'low')
  assert.deepEqual(sent.messages[0], { role: 'system', content: 'tagger' })
  assert.deepEqual(sent.messages[1], { role: 'user', content: 'Where do I park near ET?' })
})

test('createGroqClient.reply throws GroqUpstreamError with status and body on a non-2xx reply', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited',
    json: async () => ({}),
  })
  const ai = createGroqClient({ apiKey: 'gsk_testkey', fetchImpl })
  await assert.rejects(
    () => ai.reply({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof GroqUpstreamError && err.status === 429 && err.body === 'rate limited',
  )
})

test('createGroqClient reports disabled without a key and falls back to the default model', () => {
  assert.equal(createGroqClient({ apiKey: '' }).enabled, false)
  assert.equal(createGroqClient({}).enabled, false)
  assert.equal(createGroqClient({ apiKey: 'gsk_x' }).model, DEFAULT_GROQ_MODEL)
})

// Issue #253: rate-limit headers on the error, and one retry on a second model.

// A fetch that answers from `replies` in order and records every request body.
// A reply with `throws` rejects the fetch itself, like a network failure.
function scriptedFetch(replies) {
  const bodies = []
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    const next = replies[bodies.length - 1]
    if (next.throws) throw next.throws
    if (next.status === 200) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: next.content } }] }), text: async () => '' }
    }
    return {
      ok: false,
      status: next.status,
      headers: new Headers(next.headers || {}),
      text: async () => next.body || '',
      json: async () => ({}),
    }
  }
  return { fetchImpl, bodies }
}

test('GroqUpstreamError carries retry-after and x-ratelimit-remaining-tokens from the response', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 503, body: 'over capacity', headers: { 'retry-after': '7', 'x-ratelimit-remaining-tokens': '1250' } },
  ])
  const ai = createGroqClient({ apiKey: 'gsk_testkey', fetchImpl })
  await assert.rejects(
    () => ai.reply({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof GroqUpstreamError && err.status === 503 && err.retryAfter === 7 && err.remainingTokens === 1250,
  )

  // Missing or junk headers are null, never NaN or 0.
  const bare = scriptedFetch([{ status: 500, headers: { 'retry-after': 'soon', 'x-ratelimit-remaining-tokens': '' } }])
  await assert.rejects(
    () => createGroqClient({ apiKey: 'gsk_testkey', fetchImpl: bare.fetchImpl }).reply({}),
    (err) => err.retryAfter === null && err.remainingTokens === null,
  )
  assert.deepEqual(
    { ...new GroqUpstreamError(429, 'x') },
    { name: 'GroqUpstreamError', status: 429, body: 'x', retryAfter: null, remainingTokens: null },
  )
})

test('a 429 on the primary model is retried once on the fallback model', async () => {
  const { fetchImpl, bodies } = scriptedFetch([
    { status: 429, body: 'rate limited', headers: { 'retry-after': '12', 'x-ratelimit-remaining-tokens': '40' } },
    { status: 200, content: 'Tower Dining is open until 9:00 PM.' },
  ])
  const heard = []
  const onFallback = (err, models) => heard.push({ status: err.status, retryAfter: err.retryAfter, remainingTokens: err.remainingTokens, requestsSoFar: bodies.length, ...models })
  const ai = createGroqClient({ apiKey: 'gsk_testkey', fetchImpl, onFallback })
  assert.equal(ai.fallbackModel, DEFAULT_GROQ_FALLBACK_MODEL)

  const text = await ai.reply({ system: 'campus', messages: [{ role: 'user', content: 'lunch?' }], maxOutputTokens: 600 })
  assert.equal(text, 'Tower Dining is open until 9:00 PM.')
  // The caller hears about the primary's 429 once, before the retry is sent.
  assert.deepEqual(heard, [
    { status: 429, retryAfter: 12, remainingTokens: 40, requestsSoFar: 1, model: DEFAULT_GROQ_MODEL, fallbackModel: 'openai/gpt-oss-20b' },
  ])
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].model, DEFAULT_GROQ_MODEL)
  assert.equal(bodies[1].model, 'openai/gpt-oss-20b')
  // Same conversation and limits on the retry; only the model changes.
  assert.deepEqual({ ...bodies[1], model: bodies[0].model }, bodies[0])
})

test('a 429 from both models throws the last error; other statuses are not retried', async () => {
  const both = scriptedFetch([
    { status: 429, body: 'primary limited', headers: { 'retry-after': '30' } },
    { status: 429, body: 'fallback limited', headers: { 'retry-after': '5', 'x-ratelimit-remaining-tokens': '0' } },
  ])
  await assert.rejects(
    () => createGroqClient({ apiKey: 'gsk_testkey', fetchImpl: both.fetchImpl }).reply({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof GroqUpstreamError && err.status === 429 && err.body === 'fallback limited' && err.retryAfter === 5 && err.remainingTokens === 0,
  )
  assert.equal(both.bodies.length, 2, 'exactly one retry')

  const serverError = scriptedFetch([{ status: 500, body: 'boom' }, { status: 200, content: 'unused' }])
  let heard = 0
  await assert.rejects(
    () => createGroqClient({ apiKey: 'gsk_testkey', fetchImpl: serverError.fetchImpl, onFallback: () => heard++ }).reply({}),
    (err) => err.status === 500,
  )
  assert.equal(serverError.bodies.length, 1)
  assert.equal(heard, 0, 'no fallback, no onFallback')
})

test('a fallback that fails any other way keeps the primary 429, so the caller still answers busy', async () => {
  const network = new TypeError('fetch failed')
  for (const second of [{ status: 404, body: 'model_not_found' }, { status: 503, body: 'over capacity' }, { status: 400, body: 'bad field' }, { throws: network }]) {
    const { fetchImpl, bodies } = scriptedFetch([{ status: 429, body: 'primary limited', headers: { 'retry-after': '30' } }, second])
    await assert.rejects(
      () => createGroqClient({ apiKey: 'gsk_testkey', fetchImpl }).reply({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => {
        assert.ok(err instanceof GroqUpstreamError)
        assert.equal(err.status, 429)
        assert.equal(err.body, 'primary limited')
        assert.equal(err.retryAfter, 30)
        if (second.throws) assert.equal(err.fallbackError, network)
        else assert.equal(err.fallbackError.status, second.status)
        return true
      },
    )
    assert.equal(bodies.length, 2, 'exactly one retry')
  }
})

test('the fallback is off for an empty string and when it names the primary model', async () => {
  for (const options of [{ fallbackModel: '' }, { model: 'openai/gpt-oss-20b' }]) {
    const { fetchImpl, bodies } = scriptedFetch([{ status: 429 }, { status: 200, content: 'unused' }])
    const ai = createGroqClient({ apiKey: 'gsk_testkey', fetchImpl, ...options })
    assert.equal(ai.fallbackModel, null)
    await assert.rejects(() => ai.reply({}), (err) => err.status === 429)
    assert.equal(bodies.length, 1)
  }
  assert.equal(createGroqClient({ apiKey: 'gsk_x', fallbackModel: 'qwen/qwen3.6-27b' }).fallbackModel, 'qwen/qwen3.6-27b')
})
