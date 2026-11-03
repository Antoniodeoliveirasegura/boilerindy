// Expo push receipts (issue #550, item 7). A ticket from Expo only says it
// took the message; whether APNs or FCM took it comes later, in a receipt,
// best read about 15 minutes after the send and kept by Expo for 24 hours.
// deliverToPushDevices (src/pushReminders.mjs) keeps each ticket in
// push_tickets (db/supabase-push-tickets.sql, README step 55); this run, on
// the reminder tick, reads the receipts of the tickets old enough, records
// each one's outcome in `receipt` ('ok', Expo's error code, or 'expired' once
// Expo no longer has it), and deletes a phone on DeviceNotRegistered, so an
// uninstalled app is dropped within the hour. Logs carry error codes and
// counts only; a receipt's message, which can quote the token, is never read.
//
// Pure apart from the client and `getReceipts` (fetchExpoReceipts in
// src/expoPush.mjs, handed in so test/pushReceipts.test.mjs needs no network).

import { queryError } from './cronTick.mjs'
import { logSchemaMissingOnce } from './dbErrors.mjs'
import { EXPO_RECEIPTS_PER_REQUEST, fetchExpoReceipts } from './expoPush.mjs'
import { isMissingTableError } from './pushReminders.mjs'

/** Read a receipt this long after its send, as Expo advises. */
export const RECEIPT_DELAY_MINUTES = 15
/** Expo keeps a receipt this long; a ticket older than this without one is marked expired. */
export const RECEIPT_KEPT_HOURS = 24

const TICKETS_SCHEMA = { feature: 'push_tickets', sqlFile: 'db/supabase-push-tickets.sql' }

/**
 * Read and record the receipts due now, at most `max` tickets a run (one
 * Expo request). Returns a summary for the cron log: `checked` receipts read,
 * `ok`, `failed` with `errors` counted by code, `removed` phones, `expired`
 * tickets, and `reason` when nothing could be read ('not_configured' before
 * README step 55, 'expo_unavailable' when Expo did not answer). Database
 * errors other than a missing table throw a SupabaseQueryError, as the other
 * runs on the tick do.
 */
export async function runPushReceipts({ client, now = new Date(), getReceipts = (ids) => fetchExpoReceipts({ ids }), max = EXPO_RECEIPTS_PER_REQUEST, log = console }) {
  const summary = { checked: 0, ok: 0, failed: 0, removed: 0, expired: 0, errors: {} }
  const due = new Date(now.getTime() - RECEIPT_DELAY_MINUTES * 60_000).toISOString()
  const res = await client
    .from('push_tickets')
    .select('ticket_id, device_id, sent_at')
    .is('receipt', null)
    .lte('sent_at', due)
    .order('sent_at', { ascending: true })
    .limit(max)
  if (res.error) {
    if (isMissingTableError(res.error)) {
      logSchemaMissingOnce(TICKETS_SCHEMA, res.error)
      return { ...summary, reason: 'not_configured' }
    }
    throw queryError(res, 'push_tickets select')
  }
  const tickets = res.data || []
  if (!tickets.length) return summary

  const answer = await getReceipts(tickets.map((ticket) => ticket.ticket_id))
  const receipts = answer?.receipts instanceof Map ? answer.receipts : new Map()
  if (!answer?.ok && receipts.size === 0) {
    log.warn(`[push] Expo receipts unavailable (${answer?.error || 'no_answer'})`)
    return { ...summary, reason: 'expo_unavailable' }
  }

  const keptSince = now.getTime() - RECEIPT_KEPT_HOURS * 60 * 60_000
  const marks = new Map() // receipt value -> ticket ids
  const mark = (value, id) => marks.set(value, [...(marks.get(value) || []), id])
  const gone = new Set()
  for (const ticket of tickets) {
    const receipt = receipts.get(ticket.ticket_id)
    if (!receipt) {
      // Not ready yet, or past the 24 hours Expo keeps it.
      if (Date.parse(ticket.sent_at) < keptSince) {
        mark('expired', ticket.ticket_id)
        summary.expired += 1
      }
      continue
    }
    summary.checked += 1
    if (receipt.status === 'ok') {
      summary.ok += 1
      mark('ok', ticket.ticket_id)
      continue
    }
    summary.failed += 1
    summary.errors[receipt.error] = (summary.errors[receipt.error] || 0) + 1
    mark(receipt.error, ticket.ticket_id)
    if (receipt.error === 'DeviceNotRegistered') gone.add(ticket.device_id)
  }

  for (const [value, ids] of marks) {
    const update = await client.from('push_tickets').update({ receipt: value }).in('ticket_id', ids)
    if (update.error) throw queryError(update, 'push_tickets update')
  }
  if (gone.size) {
    // The app was uninstalled or its token rotated: stop sending to it. Its
    // tickets go with it (ON DELETE CASCADE).
    const del = await client.from('push_devices').delete().in('id', [...gone])
    if (del.error) log.warn(`[push] could not drop ${gone.size} phone(s) Expo no longer knows (${del.error.code || 'error'})`)
    else summary.removed = gone.size
  }
  if (summary.failed) log.warn(`[push] Expo receipt errors: ${JSON.stringify(summary.errors)}`)
  return summary
}
