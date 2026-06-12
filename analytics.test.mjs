import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANALYTICS_EVENTS,
  ANALYTICS_BATCH_MAX,
  normalizeAnalyticsBatch,
} from './analytics.mjs'

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
