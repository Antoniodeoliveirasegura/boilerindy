import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_XAI_MODEL,
  GrokUpstreamError,
  XAI_RESPONSES_URL,
  buildGrokRequest,
  createGrokClient,
  extractGrokText,
} from '../src/grokClient.mjs'

// Gemini -> Grok swap: the xAI wire format lives in src/grokClient.mjs so it can
// be checked here without booting server.mjs or holding a real key.

test('buildGrokRequest puts the system prompt first, keeps user/assistant turns only, never stores', () => {
  const body = buildGrokRequest({
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
  assert.equal(body.model, DEFAULT_XAI_MODEL)
  assert.deepEqual(body.input, [
    { role: 'system', content: 'You are BoilerIndy.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: '42' },
  ])
  assert.equal(body.store, false)
  assert.equal(body.max_output_tokens, 60)
  assert.equal(body.temperature, 0.1)
  assert.equal('reasoning' in body, false)
  assert.equal('max_tokens' in body, false, '/v1/responses rejects the chat-completions field name')
})

test('buildGrokRequest omits optional fields when absent and passes reasoning effort through', () => {
  const body = buildGrokRequest({
    model: 'grok-4.6',
    messages: [{ role: 'user', content: 'tag this' }],
    reasoningEffort: 'low',
  })
  assert.equal(body.model, 'grok-4.6')
  assert.deepEqual(body.input, [{ role: 'user', content: 'tag this' }])
  assert.deepEqual(body.reasoning, { effort: 'low' })
  assert.equal('max_output_tokens' in body, false)
  assert.equal('temperature' in body, false)
})

test('extractGrokText joins message text blocks and skips reasoning items', () => {
  const data = {
    output: [
      { type: 'reasoning', summary: [] },
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Your next class ' },
          { type: 'output_text', text: 'is at 2pm.' },
        ],
      },
    ],
  }
  assert.equal(extractGrokText(data), 'Your next class is at 2pm.')
})

test('extractGrokText returns null when there is no text (empty, refusal, malformed)', () => {
  assert.equal(extractGrokText({ output: [] }), null)
  assert.equal(
    extractGrokText({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }),
    null,
  )
  assert.equal(extractGrokText({}), null)
  assert.equal(extractGrokText(null), null)
  assert.equal(extractGrokText({ output_text: 'sdk-style convenience field' }), 'sdk-style convenience field')
})

test('createGrokClient.reply posts a bearer-authed Responses request and returns the text', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '["parking"]' }] }],
      }),
      text: async () => '',
    }
  }
  const grok = createGrokClient({ apiKey: 'xai-test-key', model: 'grok-4.3', fetchImpl })
  assert.equal(grok.enabled, true)
  assert.equal(grok.model, 'grok-4.3')

  const text = await grok.reply({
    system: 'tagger',
    messages: [{ role: 'user', content: 'Where do I park near ET?' }],
    maxOutputTokens: 60,
    temperature: 0.1,
  })
  assert.equal(text, '["parking"]')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, XAI_RESPONSES_URL)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer xai-test-key')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.model, 'grok-4.3')
  assert.equal(sent.store, false)
  assert.equal(sent.max_output_tokens, 60)
  assert.deepEqual(sent.input[0], { role: 'system', content: 'tagger' })
  assert.deepEqual(sent.input[1], { role: 'user', content: 'Where do I park near ET?' })
})

test('createGrokClient.reply throws GrokUpstreamError with status and body on a non-2xx reply', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited',
    json: async () => ({}),
  })
  const grok = createGrokClient({ apiKey: 'xai-test-key', fetchImpl })
  await assert.rejects(
    () => grok.reply({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof GrokUpstreamError && err.status === 429 && err.body === 'rate limited',
  )
})

test('createGrokClient reports disabled without a key and falls back to the default model', () => {
  assert.equal(createGrokClient({ apiKey: '' }).enabled, false)
  assert.equal(createGrokClient({}).enabled, false)
  assert.equal(createGrokClient({ apiKey: 'xai-x' }).model, DEFAULT_XAI_MODEL)
})
