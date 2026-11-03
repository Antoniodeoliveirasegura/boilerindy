import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KINDS_VERSION,
  NOTIFICATION_KIND_IDS,
  canonicalJson,
  kindsOffFromSetting,
  notificationKind,
  notificationKindsDigest,
  serverPushKind,
} from '../src/notificationKinds.mjs'
import { plusDaysYmd, zonedTimeMs } from '../src/campusTime.mjs'
import { CAMPUS_TIME_ZONE, minutesInZone } from '../src/diningMeals.mjs'

// The notification kind registry (issue #550, item 10). The app keeps a
// generated copy and compares its digest with GET /api/push/config's, so a
// change here has to say so with a new version.

// Every version of the registry, oldest first, with the digest of its
// contents. Changing NOTIFICATION_KINDS changes its digest: bump
// NOTIFICATION_KINDS_VERSION and add the new pair at the end. Never edit a
// pair already here, since an app build may hold that version.
const VERSIONS = [
  [1, 'e6981271254e24aece3ba6f3d1182450dd672b288b683d52e78d0e1addc8f658'],
]

test('the registry changes only with a version bump', async () => {
  const digest = await notificationKindsDigest()
  const [version, pinned] = VERSIONS.at(-1)
  assert.equal(
    NOTIFICATION_KINDS_VERSION,
    version,
    `NOTIFICATION_KINDS_VERSION is ${NOTIFICATION_KINDS_VERSION}: add [${NOTIFICATION_KINDS_VERSION}, '${digest}'] to VERSIONS`,
  )
  assert.equal(
    digest,
    pinned,
    `the registry changed without a version bump: set NOTIFICATION_KINDS_VERSION to ${version + 1} and add [${version + 1}, '${digest}'] to VERSIONS`,
  )
  // One version at a time, each with contents of its own.
  assert.deepEqual(VERSIONS.map(([v]) => v), VERSIONS.map((_, i) => i + 1))
  assert.equal(new Set(VERSIONS.map(([, d]) => d)).size, VERSIONS.length)
})

test('the digest is the SHA-256 of the canonical JSON, the same from Web Crypto and node:crypto', async () => {
  const expected = createHash('sha256').update(canonicalJson(NOTIFICATION_KINDS)).digest('hex')
  assert.match(expected, /^[0-9a-f]{64}$/)
  assert.equal(await notificationKindsDigest(), expected)
  // One field of one kind is enough to change it.
  const changed = structuredClone(NOTIFICATION_KINDS)
  changed.kinds[0].sound = !changed.kinds[0].sound
  assert.notEqual(await notificationKindsDigest(changed), expected)
})

test('canonicalJson sorts keys at every level, keeps array order, and refuses what JSON cannot say exactly', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: true, c: null }, 'x'], é: 0.5 }), '{"a":[{"c":null,"d":true},"x"],"b":1,"é":0.5}')
  assert.equal(canonicalJson({ a: 1, b: [2, 1] }), canonicalJson({ b: [2, 1], a: 1 }))
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
  for (const bad of [undefined, () => {}, NaN, Infinity, new Date(0), new Map(), Symbol('x'), 10n, { nested: undefined }, [undefined]]) {
    assert.throws(() => canonicalJson(bad), TypeError, String(bad))
  }
})

test('the module imports nothing and reads no environment, so the app can copy it alone and a browser can bundle it', () => {
  const source = readFileSync(new URL('../src/notificationKinds.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/m)
  assert.doesNotMatch(source, /\bimport\(|\brequire\(|process\.env/)
})

test('the registry is frozen all the way down', () => {
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return
    assert.ok(Object.isFrozen(value), `${path} is frozen`)
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`)
  }
  walk(NOTIFICATION_KINDS, 'NOTIFICATION_KINDS')
  assert.throws(() => {
    NOTIFICATION_KINDS.kinds[0].sound = false
  }, TypeError)
})

const LEVELS = ['passive', 'active', 'time-sensitive']
const QUIET_RULES = ['ignores', 'moves-to-end', 'never-inside', 'goes-silent']
const UNTIL = ['due', 'first-due', 'meal-end', 'bus-due', 'class-start']

test('every kind is complete and points at channels, categories and kinds that exist', () => {
  const channelIds = NOTIFICATION_KINDS.channels.map((c) => c.id)
  const categoryIds = NOTIFICATION_KINDS.categories.map((c) => c.id)
  assert.equal(new Set(NOTIFICATION_KIND_IDS).size, NOTIFICATION_KIND_IDS.length, 'kind ids are unique')
  assert.equal(new Set(channelIds).size, channelIds.length, 'channel ids are unique')
  assert.equal(new Set(categoryIds).size, categoryIds.length, 'category ids are unique')

  for (const kind of NOTIFICATION_KINDS.kinds) {
    const at = kind.id
    const liveActivity = kind.server === 'apns'
    const pushed = kind.server === 'push' || kind.server === 'broadcast'
    assert.match(kind.id, /^[a-z]+(-[a-z]+)*$/, at)
    assert.equal(typeof kind.later, 'boolean', at)
    assert.equal(typeof kind.phone, 'boolean', at)
    assert.ok([null, 'push', 'broadcast', 'apns'].includes(kind.server), at)
    assert.ok(kind.phone || kind.server, `${at} has a sender`)
    assert.ok(liveActivity ? kind.level === null : LEVELS.includes(kind.level), `${at} level`)
    assert.ok(liveActivity ? kind.thread === null : typeof kind.thread === 'string' && kind.thread, `${at} thread`)
    assert.ok(pushed ? kind.relevance >= 0 && kind.relevance <= 1 : kind.relevance === null, `${at} relevance`)
    assert.ok(liveActivity ? kind.channel === null : channelIds.includes(kind.channel), `${at} channel`)
    assert.equal(typeof kind.sound, 'boolean', at)
    assert.ok(QUIET_RULES.includes(kind.quietHours), `${at} quiet hours`)
    assert.ok(kind.mergeMinutes === null || (Number.isInteger(kind.mergeMinutes) && kind.mergeMinutes > 0), `${at} merge`)
    if (kind.server) {
      const { seconds, until } = kind.ttl
      assert.ok((Number.isInteger(seconds) && seconds > 0 && until === undefined) || (UNTIL.includes(until) && seconds === undefined), `${at} ttl`)
    } else {
      assert.equal(kind.ttl, null, `${at}: only the phone sends it, so it has no ttl`)
    }
    assert.ok([null, 'daily', 'own'].includes(kind.cap), `${at} cap`)
    assert.ok(kind.perDay === null || (Number.isInteger(kind.perDay) && kind.perDay > 0), `${at} per day`)
    assert.ok(kind.tap === null || /^(\/|boilerindyapp:\/\/)/.test(kind.tap), `${at} tap`)
    assert.ok(kind.category === null || categoryIds.includes(kind.category), `${at} category`)
    const d = kind.default
    assert.ok(d === null || typeof d.on === 'boolean' || NOTIFICATION_KIND_IDS.includes(d.follows), `${at} default`)
    assert.ok(Array.isArray(kind.offered) && kind.offered.every((place) => typeof place === 'string' && place), `${at} offered`)
  }

  for (const channel of NOTIFICATION_KINDS.channels) {
    assert.ok(channel.name, channel.id)
    assert.ok(['min', 'low', 'default', 'high', 'max'].includes(channel.importance), channel.id)
    assert.ok(['public', 'private', 'secret'].includes(channel.lockscreen), channel.id)
  }
  for (const category of NOTIFICATION_KINDS.categories) {
    assert.ok(category.actions.length > 0, category.id)
    for (const action of category.actions) assert.ok(action.id && action.title && action.opensApp === true, `${category.id}.${action.id}`)
  }
})

test('the rules of the design hold across the registry', () => {
  const ids = (pick) => NOTIFICATION_KINDS.kinds.filter(pick).map((kind) => kind.id)
  // Passive means silent.
  for (const id of ids((kind) => kind.level === 'passive')) assert.equal(notificationKind(id).sound, false, id)
  // Only what cannot wait breaks through a Focus.
  assert.deepEqual(ids((kind) => kind.level === 'time-sensitive'), ['class', 'campus-alert', 'bus-alert'])
  // Quiet hours and the daily cap cover everything but classes, campus alerts,
  // bus alerts, the Live Activity and the test push (the design's rule 5).
  assert.deepEqual(ids((kind) => kind.quietHours === 'ignores'), ['class', 'campus-alert', 'test', 'bus-alert', 'bus-live-activity'])
  assert.deepEqual(ids((kind) => kind.server && kind.cap !== 'daily'), ['campus-alert', 'campus-all-clear', 'test', 'bus-alert', 'bus-live-activity'])
  // Classes and deadlines are private on an Android lock screen.
  assert.deepEqual(NOTIFICATION_KINDS.channels.filter((c) => c.lockscreen === 'private').map((c) => c.id), ['classes', 'deadlines'])
  // The owner's numbers (decision 8 in the build plan).
  assert.equal(NOTIFICATION_KINDS.dailyCap, 6)
  assert.deepEqual(NOTIFICATION_KINDS.quietHours, { start: 23 * 60, end: 8 * 60 })
  assert.deepEqual(notificationKind('class').default, { on: false, leadMinutes: 15, leadChoices: [5, 10, 15, 30] })
  assert.deepEqual(notificationKind('deadline').default, { on: false, leadMinutes: 60 })
  assert.deepEqual(notificationKind('deadline-digest').default, { on: true, minute: 18 * 60 })
  assert.equal(notificationKind('dining-favorites').perDay, 1)
  assert.equal(NOTIFICATION_KINDS.timeZone, CAMPUS_TIME_ZONE)
})

test('serverPushKind names the kinds that go out through Expo and Web Push today', () => {
  assert.deepEqual(
    NOTIFICATION_KIND_IDS.filter((id) => serverPushKind(id)),
    ['deadline', 'deadline-digest', 'dining-favorites', 'campus-alert', 'campus-all-clear', 'test'],
  )
  for (const id of ['class', 'runout', 'bus-alert', 'room-change', 'bus-live-activity', 'nope', undefined, null]) {
    assert.equal(serverPushKind(id), null, String(id))
  }
  assert.equal(notificationKind('test').id, 'test')
  assert.equal(notificationKind('nope'), null)
})

test('kindsOffFromSetting reads PUSH_KINDS_OFF: the kinds the server sends, and every other word for the log', () => {
  assert.deepEqual(kindsOffFromSetting(undefined), { off: new Set(), ignored: [] })
  assert.deepEqual(kindsOffFromSetting('  '), { off: new Set(), ignored: [] })
  assert.deepEqual(kindsOffFromSetting(' Dining-Favorites, test\tdeadline '), { off: new Set(['dining-favorites', 'test', 'deadline']), ignored: [] })
  // The phone alone sends classes and the run-out notice, and a typo names nothing.
  assert.deepEqual(kindsOffFromSetting('class,runout,dinning-favorites'), { off: new Set(), ignored: ['class', 'runout', 'dinning-favorites'] })
  // Kinds not sent yet can be listed ahead of time.
  assert.deepEqual(kindsOffFromSetting('bus-alert bus-live-activity').off, new Set(['bus-alert', 'bus-live-activity']))
})

// The vectors are facts about the campus clock. Checking them against
// zonedTimeMs (src/campusTime.mjs) keeps either repo's policy code from being
// held to a wrong answer.
test('the quiet-hours and digest vectors are true on the campus clock', () => {
  const { quietHours, digest } = NOTIFICATION_KINDS.vectors
  const campusYmd = (ms) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))

  for (const c of quietHours.cases) {
    const at = Date.parse(c.at)
    const minute = minutesInZone(new Date(at))
    // 11:00 PM to 8:00 AM wraps midnight.
    assert.equal(minute >= quietHours.start || minute < quietHours.end, c.quiet, c.at)
    if (!c.quiet) {
      assert.equal(c.endsAt, null, c.at)
      continue
    }
    const morning = minute >= quietHours.start ? plusDaysYmd(campusYmd(at), 1) : campusYmd(at)
    assert.equal(zonedTimeMs(morning, quietHours.end), Date.parse(c.endsAt), c.at)
  }
  // From the first quiet minute: 8 hours the night the clocks go forward, 10 the night they go back.
  const nights = quietHours.cases.filter((c) => c.quiet && minutesInZone(new Date(c.at)) === quietHours.start)
  assert.deepEqual(nights.map((c) => (Date.parse(c.endsAt) - Date.parse(c.at)) / 3_600_000), [8, 10])
  assert.deepEqual(nights.map((c) => c.endsAt.slice(0, 10)), ['2027-03-14', '2027-11-07'])

  for (const c of digest.cases) {
    assert.equal(zonedTimeMs(c.date, digest.minute), Date.parse(c.at), c.date)
    assert.equal(zonedTimeMs(plusDaysYmd(c.date, 1), digest.minute), Date.parse(c.until), c.date)
  }
  assert.deepEqual(digest.cases.map((c) => (Date.parse(c.until) - Date.parse(c.at)) / 3_600_000), [23, 24, 25, 24])
})
