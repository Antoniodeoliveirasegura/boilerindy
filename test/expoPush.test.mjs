import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPO_CHUNK_SIZE,
  EXPO_PUSH_SEND_URL,
  buildExpoMessages,
  chunk,
  expoTtlSeconds,
  isExpoToken,
  parseExpoTickets,
  parsePushTokenBody,
  sendExpoPush,
} from '../src/expoPush.mjs'
import { notificationKind } from '../src/notificationKinds.mjs'

// Issue #194: the Expo half of push delivery. sendExpoPush takes an injected
// fetch, so nothing here reaches exp.host. Issue #550: each message carries
// its kind's fields from the kind registry.

const token = (n) => `ExponentPushToken[device${String(n).padStart(4, '0')}]`
const NOW = new Date('2026-09-08T14:00:00Z') // Tuesday 10:00 AM EDT
const PAYLOAD = {
  title: 'Assignment due in 45 min',
  body: 'HW 3 is due at 10:45 AM.',
  url: '/assignments',
  tag: 'deadline-calendar-a',
  kind: 'deadline',
  expiresAt: '2026-09-08T14:45:00.000Z',
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('isExpoToken takes both Expo spellings and nothing else', () => {
  assert.equal(isExpoToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), true)
  assert.equal(isExpoToken('ExpoPushToken[AbC-123_xyz]'), true)
  for (const bad of [
    '',
    'ExponentPushToken[]',
    'ExponentPushToken[abc',
    'ExponentPushToken[abc] ',
    'ExponentPushToken[a b]',
    'exponentpushtoken[abc]',
    'https://push.example.com/send/abc',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    `ExponentPushToken[${'a'.repeat(200)}]`,
    null,
    42,
  ]) {
    assert.equal(isExpoToken(bad), false, String(bad))
  }
})

test('parsePushTokenBody validates the token and platform and tidies the device name', () => {
  assert.deepEqual(parsePushTokenBody({ token: token(1), platform: 'ios' }), { ok: true, token: token(1), platform: 'ios', deviceName: null, localReminders: false })
  assert.deepEqual(parsePushTokenBody({ token: token(1), platform: ' Android ', deviceName: '  Pixel 9  ' }), {
    ok: true,
    token: token(1),
    platform: 'android',
    deviceName: 'Pixel 9',
    localReminders: false,
  })
  assert.equal(parsePushTokenBody({ token: token(1), platform: 'ios', deviceName: 'x'.repeat(300) }).deviceName.length, 120)
  assert.equal(parsePushTokenBody({ token: token(1), platform: 'ios', deviceName: '   ' }).deviceName, null)
  assert.equal(parsePushTokenBody({ token: token(1), platform: 'ios', deviceName: 7 }).deviceName, null)

  assert.deepEqual(parsePushTokenBody({ token: 'not-a-token', platform: 'ios' }), { ok: false, error: 'token must be an Expo push token, ExponentPushToken[...].' })
  assert.deepEqual(parsePushTokenBody({ token: token(1), platform: 'web' }), { ok: false, error: 'platform must be ios or android.' })
  assert.equal(parsePushTokenBody({ token: token(1) }).ok, false)
  assert.equal(parsePushTokenBody(null).ok, false)
})

// Antoniodeoliveirasegura/boilerindy-app#55: a phone whose app schedules the
// reminders itself says so, and the deadline run leaves it out.
test('parsePushTokenBody takes localReminders as a boolean, false when it is left out', () => {
  assert.equal(parsePushTokenBody({ token: token(1), platform: 'ios', localReminders: true }).localReminders, true)
  assert.equal(parsePushTokenBody({ token: token(1), platform: 'ios', localReminders: false }).localReminders, false)
  assert.equal(parsePushTokenBody({ token: token(1), platform: 'ios' }).localReminders, false)
  for (const bad of ['true', 'yes', 1, 0, null, {}, []]) {
    assert.deepEqual(
      parsePushTokenBody({ token: token(1), platform: 'ios', localReminders: bad }),
      { ok: false, error: 'localReminders must be true or false.' },
      JSON.stringify(bad),
    )
  }
  // The token and platform are checked first, as before.
  assert.deepEqual(parsePushTokenBody({ token: 'not-a-token', platform: 'ios', localReminders: 'yes' }), { ok: false, error: 'token must be an Expo push token, ExponentPushToken[...].' })
})

test('chunk splits in order, at most size per piece', () => {
  const list = Array.from({ length: 250 }, (_, i) => i)
  const pieces = chunk(list)
  assert.deepEqual(pieces.map((p) => p.length), [100, 100, 50])
  assert.deepEqual(pieces.flat(), list)
  assert.deepEqual(chunk([]), [])
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]])
  assert.throws(() => chunk([1], 0), /positive integer/)
})

test("buildExpoMessages turns one payload into one message per device, with its kind's fields", () => {
  const messages = buildExpoMessages([{ token: token(1) }, { token: token(2) }], PAYLOAD, { now: NOW })
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0], {
    to: token(1),
    title: 'Assignment due in 45 min',
    body: 'HW 3 is due at 10:45 AM.',
    data: { url: '/assignments', kind: 'deadline', tag: 'deadline-calendar-a' },
    interruptionLevel: 'active',
    threadId: 'deadline',
    relevanceScore: 0.7,
    categoryId: 'deadline',
    sound: 'default',
    priority: 'high',
    ttl: 45 * 60, // until HW 3 is due, not a flat 24 hours
    collapseId: 'deadline-calendar-a',
    tag: 'deadline-calendar-a',
  })
  assert.equal(messages[1].to, token(2))
  assert.equal('channelId' in messages[0], false, 'no channel until phones report the ones they created')
})

test('each kind the server pushes gets its own level, thread, sound, priority and lifetime', () => {
  const [dish] = buildExpoMessages(
    [{ token: token(1) }],
    { title: 'Beef Stroganoff is on the menu today', body: 'Beef Stroganoff (dinner, Tower Dining).', url: '/dining', tag: 'dining-favorites-2026-09-08', kind: 'dining-favorites', expiresAt: '2026-09-09T04:00:00.000Z' },
    { now: NOW },
  )
  // Passive: no sound, and normal priority, which iOS may hold and batch.
  assert.deepEqual(
    [dish.interruptionLevel, dish.threadId, dish.relevanceScore, dish.categoryId, dish.priority, dish.ttl, 'sound' in dish],
    ['passive', 'dining', 0.3, 'dining', 'normal', 14 * 60 * 60, false],
  )

  const [check] = buildExpoMessages([{ token: token(1) }], { title: 'BoilerIndy notifications are on', body: 'x', url: '/settings', tag: 'test', kind: 'test' }, { now: NOW })
  assert.deepEqual(
    [check.interruptionLevel, check.threadId, check.relevanceScore, check.sound, check.priority, check.ttl, 'categoryId' in check],
    ['active', 'account', 0.2, 'default', 'high', 60 * 60, false],
  )

  // A campus alert, once something sends one (issue #34; demo text only).
  const [alert] = buildExpoMessages(
    [{ token: token(1) }],
    { title: 'Demo alert', body: 'This is sample text, not a real emergency.', url: '/safety?incident=demo', tag: 'campus-demo', kind: 'campus-alert' },
    { now: NOW },
  )
  assert.deepEqual([alert.interruptionLevel, alert.threadId, alert.relevanceScore, alert.priority, alert.ttl], ['time-sensitive', 'safety', 1, 'high', 30 * 60])
})

test('expoTtlSeconds keeps a message until its news stops being true, never below 0', () => {
  const deadline = notificationKind('deadline')
  assert.equal(expoTtlSeconds(deadline, { expiresAt: '2026-09-08T14:45:00.000Z' }, NOW), 45 * 60)
  assert.equal(expoTtlSeconds(deadline, { expiresAt: '2026-09-08T14:00:00.900Z' }, NOW), 0, 'whole seconds, rounded down')
  assert.equal(expoTtlSeconds(deadline, { expiresAt: '2026-09-08T13:57:00.000Z' }, NOW), 0, 'due already: now or never')
  assert.equal(expoTtlSeconds(notificationKind('test'), {}, NOW), 60 * 60)
  assert.equal(expoTtlSeconds(notificationKind('campus-all-clear'), {}, NOW), 2 * 60 * 60)
  assert.throws(() => expoTtlSeconds(deadline, {}, NOW), /deadline notification needs expiresAt/)
  assert.throws(() => expoTtlSeconds(deadline, { expiresAt: 'soon' }, NOW), /needs expiresAt/)
})

test('only kinds the server pushes go out, and a kind kept until something happens needs its expiresAt', () => {
  for (const kind of [undefined, 'nope', 'class', 'runout', 'bus-alert', 'room-change', 'bus-live-activity']) {
    assert.throws(() => buildExpoMessages([{ token: token(1) }], { ...PAYLOAD, kind }, { now: NOW }), /is not a kind the server pushes/, String(kind))
  }
  assert.throws(() => buildExpoMessages([{ token: token(1) }], { ...PAYLOAD, expiresAt: undefined }, { now: NOW }), /needs expiresAt/)
})

test('buildExpoMessages clips a long feed title so the notification stays under 4 KiB', () => {
  const title = 'T'.repeat(5000)
  const [message] = buildExpoMessages(
    [{ token: token(1) }],
    { ...PAYLOAD, title, subtitle: title, body: `${title} is due at 10:45 AM.`, tag: `deadline-${'x'.repeat(100)}` },
    { now: NOW },
  )
  assert.equal(message.title.length, 120)
  assert.ok(message.title.endsWith('...'))
  assert.equal(message.subtitle.length, 120)
  assert.equal(message.body.length, 500)
  assert.equal(message.collapseId.length, 64)
  assert.ok(Buffer.byteLength(JSON.stringify(message)) < 4096)
  const [untagged] = buildExpoMessages([{ token: token(1) }], { title: 'Hi', body: 'There', kind: 'test' })
  assert.equal('collapseId' in untagged, false)
  assert.equal('subtitle' in untagged, false)
  assert.deepEqual(untagged.data, { url: null, kind: 'test', tag: null })
})

test('parseExpoTickets maps each ticket to its message, and only device errors are strikes', () => {
  const messages = buildExpoMessages([1, 2, 3, 4, 5, 6].map((n) => ({ token: token(n) })), PAYLOAD)
  const results = parseExpoTickets(messages, {
    data: [
      { status: 'ok', id: 'ticket-1' },
      { status: 'error', message: `"${token(2)}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered', expoPushToken: token(2) } },
      { status: 'error', message: 'credentials', details: { error: 'InvalidCredentials' } },
      { status: 'error', message: 'too often', details: { error: 'MessageRateExceeded' } },
      { status: 'error', message: 'something odd' },
    ],
  })
  assert.deepEqual(results, [
    { token: token(1), ok: true, ticketId: 'ticket-1' },
    { token: token(2), ok: false, error: 'DeviceNotRegistered', gone: true, strike: false },
    { token: token(3), ok: false, error: 'InvalidCredentials', gone: false, strike: false },
    { token: token(4), ok: false, error: 'MessageRateExceeded', gone: false, strike: true },
    { token: token(5), ok: false, error: 'UnknownError', gone: false, strike: true },
    { token: token(6), ok: false, error: 'no_ticket', gone: false, strike: false },
  ])
  for (const [code, strike] of [['MismatchSenderId', false], ['MessageTooBig', false]]) {
    const [result] = parseExpoTickets(messages.slice(0, 1), { data: [{ status: 'error', details: { error: code } }] })
    assert.equal(result.strike, strike, code)
  }
  assert.ok(parseExpoTickets(messages, { errors: [{ code: 'PUSH_TOO_MANY_NOTIFICATIONS' }] }).every((r) => !r.ok && !r.strike))
})

test('sendExpoPush posts 250 messages as requests of 100, 100 and 50 and keeps the order', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    const batch = JSON.parse(init.body)
    requests.push({ url, init, batch })
    return jsonResponse({
      data: batch.map((m) => (m.to === token(150) ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: `t-${m.to}` })),
    })
  }
  const messages = buildExpoMessages(Array.from({ length: 250 }, (_, i) => ({ token: token(i) })), PAYLOAD)
  const results = await sendExpoPush({ messages, fetchImpl })

  assert.deepEqual(requests.map((r) => r.batch.length), [100, 100, 50])
  assert.equal(EXPO_CHUNK_SIZE, 100)
  for (const { url, init } of requests) {
    assert.equal(url, EXPO_PUSH_SEND_URL)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['Content-Type'], 'application/json')
    assert.equal(init.headers.Accept, 'application/json')
    assert.equal(init.headers['Accept-Encoding'], 'gzip, deflate')
    assert.ok(init.signal, 'every request has a deadline')
  }
  assert.deepEqual(requests.flatMap((r) => r.batch.map((m) => m.to)), messages.map((m) => m.to))
  assert.equal(results.length, 250)
  assert.deepEqual(results.map((r) => r.token), messages.map((m) => m.to))
  assert.equal(results.filter((r) => r.ok).length, 249)
  assert.deepEqual(results[150], { token: token(150), ok: false, error: 'DeviceNotRegistered', gone: true, strike: false })
  assert.equal(results[0].ticketId, `t-${token(0)}`)
})

test('a request with no tickets fails every message in it without a strike, and the next request still goes', async () => {
  const messages = buildExpoMessages(Array.from({ length: 150 }, (_, i) => ({ token: token(i) })), PAYLOAD)

  let calls = 0
  const networkThenOk = async (_url, init) => {
    calls += 1
    if (calls === 1) throw new TypeError('fetch failed')
    return jsonResponse({ data: JSON.parse(init.body).map(() => ({ status: 'ok', id: 'x' })) })
  }
  const results = await sendExpoPush({ messages, fetchImpl: networkThenOk })
  assert.equal(calls, 2)
  assert.ok(results.slice(0, 100).every((r) => !r.ok && r.error === 'network' && !r.strike && !r.gone))
  assert.ok(results.slice(100).every((r) => r.ok))

  const allDown = await sendExpoPush({ messages: messages.slice(0, 3), fetchImpl: async () => { throw new TypeError('fetch failed') } })
  assert.deepEqual(allDown.map((r) => [r.ok, r.error, r.strike]), [[false, 'network', false], [false, 'network', false], [false, 'network', false]])

  const timeout = await sendExpoPush({
    messages: messages.slice(0, 1),
    fetchImpl: async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    },
  })
  assert.equal(timeout[0].error, 'timeout')

  const serverError = await sendExpoPush({ messages: messages.slice(0, 2), fetchImpl: async () => new Response('Bad Gateway', { status: 502 }) })
  assert.deepEqual(serverError.map((r) => [r.error, r.strike]), [['http_502', false], ['http_502', false]])

  // Expo's own code is kept for the log, never the rest of the body, which can quote a token.
  const unauthorized = await sendExpoPush({
    messages: messages.slice(0, 1),
    fetchImpl: async () => jsonResponse({ errors: [{ code: 'UNAUTHORIZED', message: `no access token for ${token(0)}` }] }, 401),
  })
  assert.equal(unauthorized[0].error, 'http_401 UNAUTHORIZED')
  assert.ok(!unauthorized[0].error.includes('PushToken'))

  const garbage = await sendExpoPush({ messages: messages.slice(0, 1), fetchImpl: async () => new Response('<html>oops</html>', { status: 200 }) })
  assert.equal(garbage[0].error, 'bad_response')

  const noData = await sendExpoPush({ messages: messages.slice(0, 1), fetchImpl: async () => jsonResponse({ errors: [] }) })
  assert.equal(noData[0].error, 'bad_response')
  assert.equal(noData[0].strike, false)
})

// Owner decision 7 on issue #550: Expo's enhanced push security, with the
// project's access token on every request.
test('sendExpoPush sends the access token as a Bearer token only when one is set', async () => {
  const seen = []
  const fetchImpl = async (_url, init) => {
    seen.push(init.headers)
    return jsonResponse({ data: JSON.parse(init.body).map(() => ({ status: 'ok', id: 'x' })) })
  }
  const messages = buildExpoMessages([{ token: token(1) }], PAYLOAD, { now: NOW })
  await sendExpoPush({ messages, fetchImpl, accessToken: 'expo-access-token-for-tests' })
  await sendExpoPush({ messages, fetchImpl })
  await sendExpoPush({ messages, fetchImpl, accessToken: '' })
  assert.equal(seen[0].Authorization, 'Bearer expo-access-token-for-tests')
  assert.equal('Authorization' in seen[1], false)
  assert.equal('Authorization' in seen[2], false)

  // Refused for want of a valid token: the result keeps Expo's code, never the token.
  const refused = await sendExpoPush({
    messages,
    accessToken: 'expo-access-token-for-tests',
    fetchImpl: async () => jsonResponse({ errors: [{ code: 'UNAUTHORIZED', message: 'The bearer token is invalid.' }] }, 401),
  })
  assert.deepEqual(refused, [{ token: token(1), ok: false, error: 'http_401 UNAUTHORIZED', gone: false, strike: false }])
  assert.ok(!JSON.stringify(refused).includes('expo-access-token-for-tests'))
})

test('nothing to send makes no request', async () => {
  let calls = 0
  const results = await sendExpoPush({ messages: [], fetchImpl: async () => { calls += 1 } })
  assert.deepEqual(results, [])
  assert.equal(calls, 0)
})
