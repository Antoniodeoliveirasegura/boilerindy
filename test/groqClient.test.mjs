import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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
