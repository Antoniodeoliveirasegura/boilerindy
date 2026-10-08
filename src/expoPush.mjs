// Native push for the Expo app (issue #194), beside the Web Push of
// src/webPush.mjs.
//
// The app asks expo-notifications for an Expo push token
// (ExponentPushToken[...]) and registers it at POST /api/me/push-token; the
// rows live in push_devices (db/supabase-push-devices.sql). Delivery posts the
// messages to Expo's send endpoint, at most 100 per request, and reads one
// ticket per message back, in the order the messages were sent:
//
// - status "ok": Expo accepted the message. That is not delivery yet: the
//   ticket id names a receipt, and polling receipts is deferred (see
//   docs/push-notifications.md, "Native devices (Expo)").
// - DeviceNotRegistered: the app was uninstalled or its token rotated. The
//   result says `gone` and the caller deletes the row.
// - InvalidCredentials or MismatchSenderId: the project's APNs or FCM
//   credentials in EAS are wrong, and MessageTooBig means our payload is over
//   4 KiB. None of that is the device's fault, so it costs the device nothing.
// - Any other ticket error is a strike (`strike: true`): the caller adds one
//   to the row's failure_count, a success clears it, and a device with
//   MAX_DEVICE_STRIKES is skipped and deleted on the next run.
// - No ticket at all (a timeout, a network failure, a 4xx or 5xx for the
//   whole request, a body without tickets): every message in that request
//   failed, and none gets a strike, because an Expo outage says nothing
//   about the devices.
//
// Expo push tokens are capabilities: anyone holding one can notify that phone
// through Expo. Nothing here logs one, the routes never return one, and the
// ticket messages, which quote the token, are dropped.
//
// Everything except sendExpoPush is pure; sendExpoPush takes `fetchImpl`, so
// test/expoPush.test.mjs runs it without the network.

import { fetchUpstreamJson } from './upstreamFetch.mjs'

export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_CHUNK_SIZE = 100 // Expo's cap on messages per send request
export const EXPO_TIMEOUT_MS = 8000
// Same lifetime as a Web Push message (DEFAULT_TTL_SECONDS in webPush.mjs).
// Without it Expo keeps an undelivered message for four weeks.
export const EXPO_TTL_SECONDS = 24 * 60 * 60
export const MAX_DEVICE_STRIKES = 5
export const PUSH_TOKEN_MAX_LENGTH = 200
export const DEVICE_NAME_MAX_LENGTH = 120
export const PUSH_DEVICE_PLATFORMS = ['ios', 'android']

// Expo caps the whole notification at 4 KiB. A calendar feed title has no
// length limit, so the text is clipped well below that; APNs takes a collapse
// id of at most 64 bytes.
const TITLE_MAX = 120
const BODY_MAX = 500
const COLLAPSE_ID_MAX = 64

const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/
// The project's push credentials or our payload, never the device.
const NOT_THE_DEVICE = new Set(['InvalidCredentials', 'MismatchSenderId', 'MessageTooBig'])

export function isExpoToken(token) {
  return typeof token === 'string' && token.length <= PUSH_TOKEN_MAX_LENGTH && EXPO_TOKEN_RE.test(token)
}

/**
 * Validate a POST /api/me/push-token body: `{ token, platform, deviceName? }`.
 * Returns { ok: true, token, platform, deviceName } or { ok: false, error }.
 * A device name longer than DEVICE_NAME_MAX_LENGTH is cut rather than refused,
 * as the web route does with the user agent.
 */
export function parsePushTokenBody(body) {
  const input = body && typeof body === 'object' ? body : {}
  if (!isExpoToken(input.token)) {
    return { ok: false, error: 'token must be an Expo push token, ExponentPushToken[...].' }
  }
  const platform = typeof input.platform === 'string' ? input.platform.trim().toLowerCase() : ''
  if (!PUSH_DEVICE_PLATFORMS.includes(platform)) {
    return { ok: false, error: 'platform must be ios or android.' }
  }
  const name = typeof input.deviceName === 'string' ? input.deviceName.trim().slice(0, DEVICE_NAME_MAX_LENGTH) : ''
  return { ok: true, token: input.token, platform, deviceName: name || null }
}

/** Split `list` into arrays of at most `size` items, in order. */
export function chunk(list, size = EXPO_CHUNK_SIZE) {
  if (!Number.isInteger(size) || size < 1) throw new Error('chunk size must be a positive integer')
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 3).trimEnd()}...` : value
}

/**
 * One Expo message per device row (`{ token }`) for a payload in the shape
 * the Web Push path sends: `{ title, body, url, tag, kind }`. `url` and
 * `kind` ride in `data` for the app to open the right screen on a tap. The
 * payload tag becomes `collapseId` (both platforms) and `tag` (Android), the
 * counterparts of the Topic header and the service worker's notification tag.
 */
export function buildExpoMessages(rows, payload) {
  const tag = payload.tag ? String(payload.tag).slice(0, COLLAPSE_ID_MAX) : null
  return rows.map((row) => {
    const message = {
      to: row.token,
      title: clip(payload.title, TITLE_MAX),
      body: clip(payload.body, BODY_MAX),
      data: { url: payload.url ?? null, kind: payload.kind ?? null, tag },
      sound: 'default',
      priority: 'high',
      ttl: EXPO_TTL_SECONDS,
    }
    if (tag) {
      message.collapseId = tag
      message.tag = tag
    }
    return message
  })
}

/**
 * Pair each message with its ticket from a send response
 * (`{ data: [ticket, ...] }`, in message order). Returns one result per
 * message: { token, ok: true, ticketId } or
 * { token, ok: false, error, gone, strike }.
 */
export function parseExpoTickets(messages, body) {
  const tickets = Array.isArray(body?.data) ? body.data : null
  return messages.map((message, i) => {
    const ticket = tickets?.[i]
    if (!ticket || typeof ticket !== 'object') {
      return { token: message.to, ok: false, error: 'no_ticket', gone: false, strike: false }
    }
    if (ticket.status === 'ok') return { token: message.to, ok: true, ticketId: ticket.id ?? null }
    const error = typeof ticket.details?.error === 'string' && ticket.details.error ? ticket.details.error : 'UnknownError'
    const gone = error === 'DeviceNotRegistered'
    return { token: message.to, ok: false, error, gone, strike: !gone && !NOT_THE_DEVICE.has(error) }
  })
}

// A whole-request failure says why in `errors[0].code` (UNAUTHORIZED,
// TOO_MANY_REQUESTS, PUSH_TOO_MANY_EXPERIENCE_IDS). Only that plain code is
// kept, read with a pattern because fetchUpstream hands back the body cut to
// 300 characters, and the rest of the body can quote tokens.
function expoErrorCode(body) {
  return /"code"\s*:\s*"([A-Z_]{1,64})"/.exec(String(body ?? ''))?.[1] ?? null
}

function transportError(err) {
  if (err?.kind === 'timeout' || err?.kind === 'network') return err.kind
  if (err?.kind === 'status' && err.status >= 300) {
    const code = expoErrorCode(err.body)
    return code ? `http_${err.status} ${code}` : `http_${err.status}`
  }
  return 'bad_response' // a 2xx whose body is not JSON
}

/**
 * Send `messages` (from buildExpoMessages) to Expo, EXPO_CHUNK_SIZE per
 * request. Never throws: the result holds one entry per message, in order,
 * as parseExpoTickets describes. A request that gets no tickets back marks
 * each of its messages failed with the transport error ('timeout',
 * 'network', 'http_<status>' plus Expo's error code when it gives one, or
 * 'bad_response') and no strike; the other chunks are still sent.
 */
export async function sendExpoPush({ messages, fetchImpl = globalThis.fetch, timeoutMs = EXPO_TIMEOUT_MS }) {
  const results = []
  for (const batch of chunk(messages || [], EXPO_CHUNK_SIZE)) {
    let body
    try {
      body = await fetchUpstreamJson('Expo', EXPO_PUSH_SEND_URL, {
        fetchImpl,
        timeoutMs,
        init: {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(batch),
        },
      })
    } catch (err) {
      const error = transportError(err)
      for (const message of batch) results.push({ token: message.to, ok: false, error, gone: false, strike: false })
      continue
    }
    if (!Array.isArray(body?.data)) {
      for (const message of batch) {
        results.push({ token: message.to, ok: false, error: 'bad_response', gone: false, strike: false })
      }
      continue
    }
    results.push(...parseExpoTickets(batch, body))
  }
  return results
}
