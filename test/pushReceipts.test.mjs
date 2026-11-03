import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RECEIPT_DELAY_MINUTES, RECEIPT_KEPT_HOURS, runPushReceipts } from '../src/pushReceipts.mjs'

// Issue #550, item 7: the receipts of Expo tickets, read on the reminder tick.
// A recording fake of the supabase-js query builder, as in the other push
// tests, and a fake getReceipts in place of Expo.

function makeClient(respond) {
  const calls = []
  return {
    calls,
    from(table) {
      const op = { table, kind: 'select', filters: [], payload: null }
      calls.push(op)
      const builder = {}
      for (const kind of ['select', 'insert', 'delete', 'update']) {
        builder[kind] = (arg) => {
          op.kind = kind
          op.payload = arg
          return builder
        }
      }
      for (const f of ['eq', 'in', 'is', 'lte', 'order', 'limit']) {
        builder[f] = (...args) => {
          op.filters.push([f, ...args])
          return builder
        }
      }
      builder.then = (resolve, reject) => Promise.resolve().then(() => respond(op)).then(resolve, reject)
      return builder
    },
  }
}

const NOW = new Date('2026-11-02T15:00:00Z')
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000).toISOString()

const TICKETS = [
  { ticket_id: 'ok-1', device_id: 'd1', sent_at: minutesAgo(20) },
  { ticket_id: 'gone-1', device_id: 'd2', sent_at: minutesAgo(30) },
  { ticket_id: 'rate-1', device_id: 'd3', sent_at: minutesAgo(40) },
  { ticket_id: 'pending-1', device_id: 'd1', sent_at: minutesAgo(16) },
  { ticket_id: 'old-1', device_id: 'd4', sent_at: minutesAgo(25 * 60) },
]

function ticketsClient({ tickets = TICKETS, selectError = null } = {}) {
  return makeClient((op) => {
    if (op.table === 'push_tickets' && op.kind === 'select') return selectError ? { data: null, error: selectError } : { data: tickets, error: null }
    return { data: null, error: null }
  })
}

const receipts = (entries) => async () => ({ ok: true, receipts: new Map(entries) })

test('reads the receipts of tickets older than 15 minutes, records each, and drops a phone Expo no longer knows', async () => {
  const client = ticketsClient()
  const warnings = []
  let asked = null
  const summary = await runPushReceipts({
    client,
    now: NOW,
    getReceipts: async (ids) => {
      asked = ids
      return receipts([
        ['ok-1', { status: 'ok' }],
        ['gone-1', { status: 'error', error: 'DeviceNotRegistered' }],
        ['rate-1', { status: 'error', error: 'MessageRateExceeded' }],
      ])()
    },
    log: { warn: (line) => warnings.push(line) },
  })
  assert.deepEqual(summary, { checked: 3, ok: 1, failed: 2, removed: 1, expired: 1, errors: { DeviceNotRegistered: 1, MessageRateExceeded: 1 } })
  assert.deepEqual(asked, ['ok-1', 'gone-1', 'rate-1', 'pending-1', 'old-1'])

  const [select, ...writes] = client.calls
  assert.deepEqual(select.filters, [
    ['is', 'receipt', null],
    ['lte', 'sent_at', minutesAgo(RECEIPT_DELAY_MINUTES)],
    ['order', 'sent_at', { ascending: true }],
    ['limit', 1000],
  ])
  assert.deepEqual(
    writes.map((c) => [c.table, c.kind, c.payload ?? null, c.filters]),
    [
      ['push_tickets', 'update', { receipt: 'ok' }, [['in', 'ticket_id', ['ok-1']]]],
      ['push_tickets', 'update', { receipt: 'DeviceNotRegistered' }, [['in', 'ticket_id', ['gone-1']]]],
      ['push_tickets', 'update', { receipt: 'MessageRateExceeded' }, [['in', 'ticket_id', ['rate-1']]]],
      // Past the 24 hours Expo keeps a receipt: it will not come.
      ['push_tickets', 'update', { receipt: 'expired' }, [['in', 'ticket_id', ['old-1']]]],
      ['push_devices', 'delete', null, [['in', 'id', ['d2']]]],
    ],
  )
  // The pending ticket is left for the next run, and the log has codes and counts only.
  assert.ok(!writes.some((c) => JSON.stringify(c.filters).includes('pending-1')))
  assert.deepEqual(warnings, ['[push] Expo receipt errors: {"DeviceNotRegistered":1,"MessageRateExceeded":1}'])
  assert.equal(RECEIPT_KEPT_HOURS, 24)
})

test('nothing to read, Expo down, or the table missing: nothing changes', async (t) => {
  const quietClient = ticketsClient({ tickets: [] })
  const nothing = await runPushReceipts({ client: quietClient, now: NOW, getReceipts: async () => assert.fail('no request') })
  assert.deepEqual(nothing, { checked: 0, ok: 0, failed: 0, removed: 0, expired: 0, errors: {} })

  const warnings = []
  const downClient = ticketsClient()
  const down = await runPushReceipts({
    client: downClient,
    now: NOW,
    getReceipts: async () => ({ ok: false, error: 'network', receipts: new Map() }),
    log: { warn: (line) => warnings.push(line) },
  })
  assert.equal(down.reason, 'expo_unavailable')
  assert.equal(downClient.calls.length, 1, 'no ticket is marked, so the next run tries again')
  assert.deepEqual(warnings, ['[push] Expo receipts unavailable (network)'])

  // Before README step 55 the table is missing: the log names the file once.
  const log = t.mock.method(console, 'error', () => {})
  const missing = await runPushReceipts({
    client: ticketsClient({ selectError: { code: 'PGRST205', message: "Could not find the table 'public.push_tickets' in the schema cache" } }),
    now: NOW,
    getReceipts: async () => assert.fail('no request'),
  })
  assert.equal(missing.reason, 'not_configured')
  assert.match(String(log.mock.calls[0]?.arguments[0]), /db\/supabase-push-tickets\.sql/)

  await assert.rejects(
    runPushReceipts({ client: ticketsClient({ selectError: { code: '57014', message: 'canceling statement due to statement timeout' } }), now: NOW }),
    /push_tickets select/,
  )
})

test('receipts read before Expo stopped answering are still recorded', async () => {
  const client = ticketsClient()
  const summary = await runPushReceipts({
    client,
    now: NOW,
    getReceipts: async () => ({ ok: false, error: 'timeout', receipts: new Map([['ok-1', { status: 'ok' }]]) }),
    log: { warn() {} },
  })
  assert.deepEqual([summary.checked, summary.ok, summary.expired], [1, 1, 1])
})
