import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordListingReport } from '../src/marketplaceReports.mjs'
import { MAX_REPORT_REASON } from '../src/marketplace.mjs'
import { fakeSupabase, hasCall, operation } from './routes/fakeSupabase.mjs'

// Issue #192: a listing report writes marketplace_reports (which hides the
// listing at three distinct reporters, #204) and content_reports (the admin
// queue), whichever route it came through.

const LISTING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REPORTER = '11111111-1111-4111-8111-111111111111'
const NOW = '2026-09-27T12:00:00.000Z'

function world({ reporters = 1, insertError = null, queueError = null } = {}) {
  return fakeSupabase({
    marketplace_reports: (chain) => (operation(chain) === 'insert' ? { data: null, error: insertError } : { count: reporters, error: null }),
    marketplace_listings: () => ({ data: null, error: null }),
    content_reports: () => ({ data: null, error: queueError }),
  })
}

const report = (overrides = {}) => ({ listingId: LISTING, reporterId: REPORTER, reason: 'other', details: 'never shipped', now: NOW, ...overrides })

test('a report writes the composed reason to marketplace_reports and the split one to the queue', async () => {
  const supabase = world()
  assert.deepEqual(await recordListingReport(supabase, report()), { duplicate: false, hidden: false })
  const [insert, count] = supabase.queriesOf('marketplace_reports')
  assert.ok(hasCall(insert.chain, 'insert', { listing_id: LISTING, reporter_id: REPORTER, reason: 'other: never shipped', created_at: NOW }))
  assert.ok(hasCall(count.chain, 'select', 'reporter_id', { count: 'exact', head: true }))
  assert.ok(hasCall(count.chain, 'eq', 'listing_id', LISTING))
  const [queue] = supabase.queriesOf('content_reports')
  assert.ok(
    hasCall(queue.chain, 'insert', {
      target_type: 'marketplace',
      target_id: LISTING,
      reporter_id: REPORTER,
      reason: 'other',
      details: 'never shipped',
      created_at: NOW,
    }),
  )
  assert.equal(supabase.queriesOf('marketplace_listings').length, 0, 'one reporter does not hide the listing')
})

test('a bare reason stays bare, and each table gets details cut to its own width', async () => {
  const supabase = world()
  await recordListingReport(supabase, report({ reason: 'spam', details: '' }))
  assert.equal(supabase.queriesOf('marketplace_reports')[0].chain[0].args[0].reason, 'spam')
  assert.equal(supabase.queriesOf('content_reports')[0].chain[0].args[0].details, '')

  const long = world()
  await recordListingReport(long, report({ details: 'x'.repeat(900) }))
  assert.equal(long.queriesOf('marketplace_reports')[0].chain[0].args[0].reason.length, MAX_REPORT_REASON)
  assert.equal(long.queriesOf('content_reports')[0].chain[0].args[0].details.length, 500)
})

test('the third distinct reporter hides the listing, and so does any report after it', async () => {
  for (const reporters of [3, 4]) {
    const supabase = world({ reporters })
    assert.deepEqual(await recordListingReport(supabase, report()), { duplicate: false, hidden: true })
    const [hide] = supabase.queriesOf('marketplace_listings')
    assert.ok(hasCall(hide.chain, 'update', { hidden: true }))
    assert.ok(hasCall(hide.chain, 'eq', 'id', LISTING))
    assert.equal(supabase.queriesOf('content_reports').length, 1, 'the report still reaches the queue')
  }
  const two = world({ reporters: 2 })
  assert.equal((await recordListingReport(two, report())).hidden, false)
})

test('a duplicate from the same reporter writes and recounts nothing', async () => {
  const supabase = world({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "marketplace_reports_pkey"' } })
  assert.deepEqual(await recordListingReport(supabase, report()), { duplicate: true, hidden: false })
  assert.equal(supabase.queriesOf('marketplace_reports').length, 1, 'no recount')
  assert.equal(supabase.queriesOf('content_reports').length, 0)
  assert.equal(supabase.queriesOf('marketplace_listings').length, 0)
})

test('the queue insert ignores its own duplicate and a missing table, and throws anything else', async () => {
  const dup = world({ queueError: { code: '23505', message: 'duplicate key value violates unique constraint' } })
  assert.deepEqual(await recordListingReport(dup, report()), { duplicate: false, hidden: false })

  // README step 38 not run yet: the marketplace keeps working through its own table.
  const missing = world({ reporters: 3, queueError: { code: 'PGRST205', message: "Could not find the table 'public.content_reports' in the schema cache" } })
  assert.deepEqual(await recordListingReport(missing, report()), { duplicate: false, hidden: true })

  const broken = world({ queueError: { code: '23514', message: 'new row violates check constraint' } })
  await assert.rejects(recordListingReport(broken, report()), (err) => err.code === '23514')
})

test('a failed marketplace_reports insert is thrown before anything else runs', async () => {
  const supabase = world({ insertError: { code: '23503', message: 'insert or update violates foreign key constraint' } })
  await assert.rejects(recordListingReport(supabase, report()), (err) => err.code === '23503')
  assert.equal(supabase.queriesOf('content_reports').length, 0)
})
