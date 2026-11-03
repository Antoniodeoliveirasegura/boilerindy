import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANALYTICS_EVENTS,
  ANALYTICS_BATCH_MAX,
  normalizeAnalyticsBatch,
} from '../src/analytics.mjs'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const WEB_SRC = join(REPO_ROOT, 'boilerindy-react', 'src')
const SOURCE_FILE = /\.(js|jsx|ts|tsx)$/
const TEST_FILE = /\.test\.(js|jsx|ts|tsx)$/
const TRACK_CALL = /\btrack\(\s*['"`]([a-z0-9_]+)['"`]/g

// Every event name the website passes to track(), mapped to the first file
// that sends it. Test files are skipped: they may send names on purpose.
function trackedEventNames(dir = WEB_SRC, names = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      trackedEventNames(path, names)
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      for (const [, name] of readFileSync(path, 'utf8').matchAll(TRACK_CALL)) {
        if (!names.has(name)) names.set(name, relative(REPO_ROOT, path))
      }
    }
  }
  return names
}

test('allowlist contains the issue #51 starter events', () => {
  for (const name of [
    'page_view',
    'source_synced',
    'board_post_created',
    'assistant_message_sent',
    'dining_viewed',
    'transit_viewed',
    'task_completed',
  ]) {
    assert.ok(ANALYTICS_EVENTS.includes(name), `${name} missing from allowlist`)
  }
})

// The native app's notification events (issue #550, boilerindy-app#172 item
// 9): accepted here first, so the app's batches never carry a name the server
// would refuse.
test('the notification events are accepted, alone and beside a page view', () => {
  const rows = normalizeAnalyticsBatch({
    events: [
      { event_name: 'notification_opened', props: { kind: 'deadline', action: 'default' } },
      { event_name: 'notification_setting_changed', props: { kind: 'dining-favorites', on: true } },
      { event_name: 'notification_permission', props: { result: 'granted', from: 'offer' } },
      { event_name: 'notification_offer', props: { kind: 'class', accepted: false } },
      { event_name: 'page_view', page: '/profile' },
    ],
  })
  assert.deepEqual(rows.map((row) => row.event_name), [
    'notification_opened',
    'notification_setting_changed',
    'notification_permission',
    'notification_offer',
    'page_view',
  ])
  assert.deepEqual(rows[0].props, { kind: 'deadline', action: 'default' })
})

// One unknown name makes normalizeAnalyticsBatch reject the whole batch, and
// usageStats.ts has already taken the batch off its queue, so a page that
// tracks an unlisted name silently loses its page_view too (#421).
test('every track() call in the website names an allowlisted event', () => {
  const names = trackedEventNames()
  assert.ok(names.has('page_view'), 'found no track("page_view") call: did the website source move?')
  for (const [name, file] of names) {
    assert.ok(ANALYTICS_EVENTS.includes(name), `${name} is tracked in ${file} but missing from ANALYTICS_EVENTS`)
  }
})

test('normalizes a valid batch into insertable rows', () => {
  const rows = normalizeAnalyticsBatch({
    events: [
      { event_name: 'page_view', page: '/dashboard', props: { ref: 'nav' } },
      { event_name: 'task_completed' },
    ],
  })
  assert.deepEqual(rows, [
    { event_name: 'page_view', page: '/dashboard', props: { ref: 'nav' } },
    { event_name: 'task_completed', page: null, props: {} },
  ])
})

test('rejects a non-array or empty batch', () => {
  assert.throws(() => normalizeAnalyticsBatch({}), /events/i)
  assert.throws(() => normalizeAnalyticsBatch({ events: [] }), /events/i)
  assert.throws(() => normalizeAnalyticsBatch({ events: 'page_view' }), /events/i)
})

test('rejects batches over the max size', () => {
  const events = Array.from({ length: ANALYTICS_BATCH_MAX + 1 }, () => ({ event_name: 'page_view' }))
  assert.throws(() => normalizeAnalyticsBatch({ events }), /at most/i)
})

test('rejects event names outside the allowlist', () => {
  assert.throws(
    () => normalizeAnalyticsBatch({ events: [{ event_name: 'keylogger_dump' }] }),
    /event/i,
  )
  assert.throws(() => normalizeAnalyticsBatch({ events: [{}] }), /event/i)
})

// The native app's sign-in calendar reminder
// (Antoniodeoliveirasegura/boilerindy-app#150): accepted here first, so the
// app's batches never carry a name the server would refuse.
test('the calendar reminder events are accepted with their case, beside a page view', () => {
  const rows = normalizeAnalyticsBatch({
    events: [
      { event_name: 'calendar_reminder_shown', props: { case: 'none' } },
      { event_name: 'calendar_reminder_connect', props: { case: 'schedule' } },
      { event_name: 'calendar_reminder_not_now', props: { case: 'brightspace' } },
      { event_name: 'calendar_reminder_opted_out', props: { case: 'broken' } },
      { event_name: 'page_view', page: '/dashboard' },
    ],
  })
  assert.deepEqual(rows.map((row) => row.event_name), [
    'calendar_reminder_shown',
    'calendar_reminder_connect',
    'calendar_reminder_not_now',
    'calendar_reminder_opted_out',
    'page_view',
  ])
  assert.deepEqual(rows[3].props, { case: 'broken' })
})

test('coerces page to a trimmed string or null and caps its length', () => {
  const [short] = normalizeAnalyticsBatch({
    events: [{ event_name: 'page_view', page: '  /dining  ' }],
  })
  assert.equal(short.page, '/dining')

  const [empty] = normalizeAnalyticsBatch({ events: [{ event_name: 'page_view', page: '   ' }] })
  assert.equal(empty.page, null)

  const [long] = normalizeAnalyticsBatch({
    events: [{ event_name: 'page_view', page: '/x'.repeat(400) }],
  })
  assert.equal(long.page.length, 300)
})

test('accepts only plain objects for props and caps their serialized size', () => {
  const [defaulted] = normalizeAnalyticsBatch({
    events: [{ event_name: 'page_view', props: ['not', 'an', 'object'] }],
  })
  assert.deepEqual(defaulted.props, {})

  assert.throws(
    () =>
      normalizeAnalyticsBatch({
        events: [{ event_name: 'page_view', props: { blob: 'x'.repeat(3000) } }],
      }),
    /props/i,
  )
})
