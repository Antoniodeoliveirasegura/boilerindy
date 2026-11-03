// The notification kind registry (issue #550, item 10): every kind of
// notification BoilerIndy sends, from the phone or from this server, with how
// loud it is, how it stacks, where a tap goes, how long it stays true, and how
// quiet hours and the daily cap treat it. The server owns it. The native app
// keeps a generated copy (src/lib/notification-kinds.json in boilerindy-app,
// written by its sync script from this file), so the two describe every kind
// the same way, and the website can import it as
// ../../../src/notificationKinds.mjs. docs/push-notifications.md, "Kind
// registry", has the table and the rules.
//
// This file imports nothing and reads no environment variable, on purpose: the
// app's sync script reads it on its own (git show
// origin/develop:src/notificationKinds.mjs), and a browser bundle can take it
// whole. test/notificationKinds.test.mjs holds it to that.
//
// NOTIFICATION_KINDS is everything a copy has to agree on, and
// notificationKindsDigest() is the SHA-256 of its canonical JSON (keys sorted
// at every level, no spaces: canonicalJson below). Any change to it, however
// small, bumps NOTIFICATION_KINDS_VERSION: the test pins the digest of every
// version and fails on a change without a bump. GET /api/push/config reports
// both, so the app can tell when its copy is behind production, and the server
// can avoid sending a phone a kind newer than the version it registered with
// (item 4).
//
// A kind:
// - id: how payloads (`kind`), push_deliveries.kind, PUSH_KINDS_OFF and a
//   phone's registered kinds spell it.
// - later: designed, not built. The server sends none of these yet.
// - phone: the app schedules it on the phone as a local notification.
// - server: what this server sends: 'push' (to the student's browsers and
//   phones), 'broadcast' (to every device that allows the kind), 'apns' (Live
//   Activity updates straight to Apple), or null.
// - level: the iOS interruption level as Expo's push API spells it ('passive',
//   'active', 'time-sensitive'; the app's local content spells the last one
//   timeSensitive). Null for the Live Activity.
// - thread: the iOS thread; notifications that share one stack together.
// - relevance: iOS's relevance score for the notification summary, 0 to 1, on
//   what the server sends; null for what only the phone sends.
// - channel: the Android channel (`channels`); null where iOS is the only home.
// - sound: plays the default sound (the Live Activity: only its Arriving
//   update, which also alerts).
// - quietHours: 'ignores'; 'moves-to-end' (held to the end of quiet hours, and
//   dropped once it is no longer true); 'never-inside' (its time cannot be set
//   inside them); 'goes-silent' (still sent, passive and without a sound).
// - mergeMinutes: notifications of the kind due within this many minutes of
//   each other become one.
// - ttl: how long an undelivered copy is kept: { seconds }, or { until } when
//   the payload's expiresAt says (a deadline's due time, the end of the meal a
//   dish alert names). Null for what only the phone sends. The Live Activity's
//   updates live 60 seconds each, and it ends after lifeMinutes.
// - cap: 'daily' (one of the dailyCap server pushes a student gets a day),
//   'own' (a cap of its own), or null; perDay: at most this many a day.
// - tap: where a tap goes. For what the server sends, the website path and
//   query parameters its `url` carries, which the app maps to a screen; for
//   what only the phone sends, the app route. Null opens the app.
// - category: the actions it offers (`categories`), or null. All of them open
//   the app.
// - default: the account's starting choice, { on } with its timing, or
//   { follows } when it goes with another kind; null when it is sent on demand.
// - offered: where the app offers it to a student.

export const NOTIFICATION_KINDS_VERSION = 1

const KINDS = [
  {
    id: 'class',
    later: false,
    phone: true,
    server: null,
    level: 'time-sensitive',
    thread: 'class',
    relevance: null,
    channel: 'classes',
    sound: true,
    quietHours: 'ignores',
    mergeMinutes: null,
    ttl: null,
    cap: null,
    perDay: null,
    tap: '/events/[id]',
    category: 'class',
    default: { on: false, leadMinutes: 15, leadChoices: [5, 10, 15, 30] },
    offered: ['calendar-connect', 'card'],
  },
  {
    // The phone schedules a student's deadlines; the server's deadline run
    // covers browsers and app builds from before per-device kinds.
    id: 'deadline',
    later: false,
    phone: true,
    server: 'push',
    level: 'active',
    thread: 'deadline',
    relevance: 0.7,
    channel: 'deadlines',
    sound: true,
    quietHours: 'moves-to-end',
    mergeMinutes: 30,
    ttl: { until: 'due' },
    cap: 'daily',
    perDay: null,
    tap: '/assignments?taskId&taskKind',
    category: 'deadline',
    default: { on: false, leadMinutes: 60 },
    offered: ['card'],
  },
  {
    // "3 due tonight": the evening list. One over the daily cap folds into the next.
    id: 'deadline-digest',
    later: false,
    phone: true,
    server: 'push',
    level: 'active',
    thread: 'deadline',
    relevance: 0.8,
    channel: 'deadlines',
    sound: true,
    quietHours: 'never-inside',
    mergeMinutes: null,
    ttl: { until: 'first-due' },
    cap: 'daily',
    perDay: null,
    tap: '/assignments',
    category: null,
    default: { on: true, minute: 18 * 60 },
    offered: ['calendar-connect', 'card'],
  },
  {
    id: 'dining-favorites',
    later: false,
    phone: false,
    server: 'push',
    level: 'passive',
    thread: 'dining',
    relevance: 0.3,
    channel: 'dining',
    sound: false,
    quietHours: 'never-inside',
    mergeMinutes: null,
    ttl: { until: 'meal-end' },
    cap: 'daily',
    perDay: 1,
    tap: '/dining?hall&meal',
    category: 'dining',
    default: { on: false },
    offered: ['first-starred-dish'],
  },
  {
    // IU Indianapolis emergencies (issue #34): an incident's first message.
    // On by default only where notifications are already allowed.
    id: 'campus-alert',
    later: false,
    phone: false,
    server: 'broadcast',
    level: 'time-sensitive',
    thread: 'safety',
    relevance: 1,
    channel: 'safety',
    sound: true,
    quietHours: 'ignores',
    mergeMinutes: null,
    ttl: { seconds: 30 * 60 },
    cap: null,
    perDay: null,
    tap: '/safety?incident',
    category: null,
    default: { on: true },
    offered: ['card', 'banner'],
  },
  {
    // IU's "Campus Status Normal" that closes an incident; it replaces the
    // alert through the shared collapse id.
    id: 'campus-all-clear',
    later: false,
    phone: false,
    server: 'broadcast',
    level: 'active',
    thread: 'safety',
    relevance: 0.6,
    channel: 'safety',
    sound: true,
    quietHours: 'goes-silent',
    mergeMinutes: null,
    ttl: { seconds: 2 * 60 * 60 },
    cap: null,
    perDay: null,
    tap: '/safety?incident',
    category: null,
    default: { follows: 'campus-alert' },
    offered: [],
  },
  {
    // "Open BoilerIndy to keep your reminders coming", at the end of what the
    // phone has planned.
    id: 'runout',
    later: false,
    phone: true,
    server: null,
    level: 'passive',
    thread: 'notices',
    relevance: null,
    channel: 'local-reminder-notices',
    sound: false,
    quietHours: 'moves-to-end',
    mergeMinutes: null,
    ttl: null,
    cap: null,
    perDay: null,
    tap: null,
    category: null,
    default: { on: true },
    offered: [],
  },
  {
    id: 'test',
    later: false,
    phone: false,
    server: 'push',
    level: 'active',
    thread: 'account',
    relevance: 0.2,
    channel: 'general',
    sound: true,
    quietHours: 'ignores',
    mergeMinutes: null,
    ttl: { seconds: 60 * 60 },
    cap: null,
    perDay: null,
    tap: '/settings',
    category: null,
    default: null,
    offered: ['website-settings'],
  },
  {
    id: 'bus-alert',
    later: true,
    phone: false,
    server: 'push',
    level: 'time-sensitive',
    thread: 'transit',
    relevance: 0.9,
    channel: 'transit',
    sound: true,
    quietHours: 'ignores',
    mergeMinutes: null,
    ttl: { until: 'bus-due' },
    cap: 'own',
    perDay: null,
    tap: '/transit?stop',
    category: 'transit',
    default: { on: false },
    offered: ['transit-stop'],
  },
  {
    // A calendar re-sync that moves an upcoming class (issue #544).
    id: 'room-change',
    later: true,
    phone: false,
    server: 'push',
    level: 'active',
    thread: 'class',
    relevance: 0.9,
    channel: 'classes',
    sound: true,
    quietHours: 'moves-to-end',
    mergeMinutes: null,
    ttl: { until: 'class-start' },
    cap: 'daily',
    perDay: null,
    tap: '/schedule?item&at',
    category: 'class',
    default: { follows: 'class' },
    offered: [],
  },
  {
    // Track this bus (boilerindy-app#173, item 5): a Live Activity on the Lock
    // Screen and in the Dynamic Island, updated over APNs. Its End button is
    // the activity's own, not a notification action.
    id: 'bus-live-activity',
    later: false,
    phone: false,
    server: 'apns',
    level: null,
    thread: null,
    relevance: null,
    channel: null,
    sound: true,
    quietHours: 'ignores',
    mergeMinutes: null,
    ttl: { seconds: 60 },
    lifeMinutes: 30,
    cap: null,
    perDay: null,
    tap: 'boilerindyapp://map?view=transit&stop',
    category: null,
    default: { on: false },
    offered: ['track-this-bus'],
  },
]

// Android channels. The app creates the ones a kind it shows uses, at launch;
// the server names one in a message only for a phone that reported it (item
// 4), because Android hides a notification whose channel the phone lacks. A
// channel's importance cannot be changed once a phone has it.
const CHANNELS = [
  { id: 'classes', name: 'Classes', importance: 'high', lockscreen: 'private' },
  { id: 'deadlines', name: 'Deadlines', importance: 'default', lockscreen: 'private' },
  { id: 'dining', name: 'Dining favorites', importance: 'low', lockscreen: 'public' },
  { id: 'safety', name: 'Campus alerts', importance: 'high', lockscreen: 'public' },
  { id: 'local-reminder-notices', name: 'Reminder notices', importance: 'low', lockscreen: 'public' },
  { id: 'general', name: 'General', importance: 'default', lockscreen: 'public' },
  { id: 'transit', name: 'Bus alerts', importance: 'high', lockscreen: 'public' },
]

// Notification actions by category. Each opens the app, so no background task
// is needed.
const CATEGORIES = [
  { id: 'class', actions: [{ id: 'directions', title: 'Directions', opensApp: true }] },
  { id: 'deadline', actions: [{ id: 'mark-done', title: 'Mark done', opensApp: true }] },
  { id: 'dining', actions: [{ id: 'see-menu', title: 'See the menu', opensApp: true }] },
  { id: 'transit', actions: [{ id: 'track', title: 'Track', opensApp: true }] },
]

// The cases both repos' quiet-hours and digest code must pass (the server's in
// this repo, the app's src/lib/notification-policy.ts), on the two days of 2027
// the clocks change on campus. Times are campus wall-clock minutes past
// midnight, never "now plus N hours".
const VECTORS = {
  // Quiet hours from 11:00 PM to 8:00 AM. A notification at `at` is inside
  // them when `quiet`, and is held to `endsAt`; the first minute of quiet
  // hours is inside, the minute they end is not.
  quietHours: {
    start: 23 * 60,
    end: 8 * 60,
    cases: [
      // The night into 2027-03-14, clocks forward: 11:00 PM EST to 8:00 AM EDT, 8 hours.
      { at: '2027-03-14T03:59:00Z', quiet: false, endsAt: null }, // 10:59 PM
      { at: '2027-03-14T04:00:00Z', quiet: true, endsAt: '2027-03-14T12:00:00Z' }, // 11:00 PM
      { at: '2027-03-14T07:00:00Z', quiet: true, endsAt: '2027-03-14T12:00:00Z' }, // 3:00 AM EDT, just after the jump
      { at: '2027-03-14T11:59:00Z', quiet: true, endsAt: '2027-03-14T12:00:00Z' }, // 7:59 AM
      { at: '2027-03-14T12:00:00Z', quiet: false, endsAt: null }, // 8:00 AM
      // The night into 2027-11-07, clocks back: 11:00 PM EDT to 8:00 AM EST, 10 hours.
      { at: '2027-11-07T02:59:00Z', quiet: false, endsAt: null }, // 10:59 PM
      { at: '2027-11-07T03:00:00Z', quiet: true, endsAt: '2027-11-07T13:00:00Z' }, // 11:00 PM
      { at: '2027-11-07T05:30:00Z', quiet: true, endsAt: '2027-11-07T13:00:00Z' }, // 1:30 AM EDT
      { at: '2027-11-07T06:30:00Z', quiet: true, endsAt: '2027-11-07T13:00:00Z' }, // 1:30 AM EST, the same clock time again
      { at: '2027-11-07T12:59:00Z', quiet: true, endsAt: '2027-11-07T13:00:00Z' }, // 7:59 AM
      { at: '2027-11-07T13:00:00Z', quiet: false, endsAt: null }, // 8:00 AM
    ],
  },
  // The 6:00 PM digest on the days around the changes. The digest on `date`
  // goes at `at` and lists what is due after it, up to `until`, the next
  // day's digest, so nothing falls between two digests when a day is 23 or 25
  // hours long.
  digest: {
    minute: 18 * 60,
    cases: [
      { date: '2027-03-13', at: '2027-03-13T23:00:00Z', until: '2027-03-14T22:00:00Z' }, // 23 hours
      { date: '2027-03-14', at: '2027-03-14T22:00:00Z', until: '2027-03-15T22:00:00Z' },
      { date: '2027-11-06', at: '2027-11-06T22:00:00Z', until: '2027-11-07T23:00:00Z' }, // 25 hours
      { date: '2027-11-07', at: '2027-11-07T23:00:00Z', until: '2027-11-08T23:00:00Z' },
    ],
  },
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * The registry, frozen: the account defaults that are not one kind's (quiet
 * hours as campus minutes past midnight, the daily cap of server pushes), the
 * kinds, the Android channels, the action categories and the test vectors.
 */
export const NOTIFICATION_KINDS = deepFreeze({
  timeZone: 'America/Indiana/Indianapolis',
  quietHours: { start: 23 * 60, end: 8 * 60 },
  dailyCap: 6,
  kinds: KINDS,
  channels: CHANNELS,
  categories: CATEGORIES,
  vectors: VECTORS,
})

const BY_ID = new Map(KINDS.map((kind) => [kind.id, kind]))

export const NOTIFICATION_KIND_IDS = Object.freeze(KINDS.map((kind) => kind.id))

/** The registry entry for a kind id, or null. */
export function notificationKind(id) {
  return BY_ID.get(id) ?? null
}

/**
 * The entry for a kind the server pushes through Expo and Web Push today
 * ('push' or 'broadcast', not later), or null for anything else: an unknown
 * id, a kind only the phone sends, the Live Activity, a later kind.
 */
export function serverPushKind(id) {
  const kind = notificationKind(id)
  return kind && !kind.later && (kind.server === 'push' || kind.server === 'broadcast') ? kind : null
}

/**
 * PUSH_KINDS_OFF to the kinds it stops: kind ids separated by commas or spaces
 * ("dining-favorites, test"). Returns { off, ignored }: the ids of kinds this
 * server sends (a Set), and every other word, for the boot log. A kind only
 * the phone schedules cannot be stopped from here.
 */
export function kindsOffFromSetting(value) {
  const words = String(value ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean)
  const sent = (word) => Boolean(notificationKind(word)?.server)
  return { off: new Set(words.filter(sent)), ignored: words.filter((word) => !sent(word)) }
}

/**
 * JSON with the keys of every object sorted (by UTF-16 code unit, as
 * Array.prototype.sort does) and no whitespace: the same text for the same
 * registry in any engine, which is what the digest is taken over. Throws on
 * anything JSON cannot say exactly (undefined, functions, non-finite numbers,
 * class instances), so the registry cannot hold a value a copy would lose.
 */
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson cannot write ${value}`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new TypeError(`canonicalJson cannot write a ${typeof value}`)
}

/**
 * The registry's digest: the SHA-256 of canonicalJson(registry), as 64
 * lowercase hex characters. Web Crypto, so it runs in Node and in a browser
 * alike (hence the promise).
 */
export async function notificationKindsDigest(registry = NOTIFICATION_KINDS) {
  const bytes = new TextEncoder().encode(canonicalJson(registry))
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
