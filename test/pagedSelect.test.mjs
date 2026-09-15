import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MAX_ROWS, DEFAULT_PAGE_SIZE, fetchAllPages } from '../src/pagedSelect.mjs'

// Issue #198: PostgREST truncates every response to max-rows (1000 on hosted
// Supabase) without an error, so `.limit(5000)` quietly returned the oldest
// 1000 rows. fetchAllPages pages with .range() instead. The fake below models
// that server cap: whatever range is asked for, at most `maxRows` rows come back.

function makeTable(rowCount, { maxRows = DEFAULT_PAGE_SIZE, failOnCall = null } = {}) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i }))
  const calls = []
  const makeQuery = (from, to) => {
    const call = { makeQueryArgs: [from, to], range: null }
    calls.push(call)
    return {
      range(rangeFrom, rangeTo) {
        call.range = [rangeFrom, rangeTo]
        if (failOnCall === calls.length) {
          return Promise.resolve({ data: null, error: { message: 'boom' } })
        }
        const wanted = rangeTo - rangeFrom + 1
        const data = rows.slice(rangeFrom, rangeFrom + Math.min(wanted, maxRows))
        return Promise.resolve({ data, error: null })
      },
    }
  }
  return { rows, calls, makeQuery }
}

test('defaults match the hosted max-rows and the class scan cap', () => {
  assert.equal(DEFAULT_PAGE_SIZE, 1000)
  assert.equal(DEFAULT_MAX_ROWS, 5000)
})

test('a 1200-row read that one capped response would truncate arrives whole', async () => {
  const table = makeTable(1200)

  // What the old single query saw: one response, capped at max-rows.
  const single = await table.makeQuery(0, 4999).range(0, 4999)
  assert.equal(single.data.length, 1000)

  table.calls.length = 0
  const { data, error } = await fetchAllPages(table.makeQuery)
  assert.equal(error, null)
  assert.equal(data.length, 1200)
  assert.deepEqual(data.map((row) => row.id), table.rows.map((row) => row.id))
  assert.deepEqual(
    table.calls.map((call) => call.range),
    [[0, 999], [1000, 1999]],
  )
})

test('the helper applies .range() with the same bounds it passes to makeQuery', async () => {
  const table = makeTable(250)
  await fetchAllPages(table.makeQuery, { pageSize: 100 })
  for (const call of table.calls) {
    assert.deepEqual(call.range, call.makeQueryArgs)
  }
  assert.deepEqual(
    table.calls.map((call) => call.range),
    [[0, 99], [100, 199], [200, 299]],
  )
})

test('an exact multiple of the page size needs one extra, empty page to know it is done', async () => {
  const table = makeTable(2000)
  const { data } = await fetchAllPages(table.makeQuery)
  assert.equal(data.length, 2000)
  assert.equal(table.calls.length, 3)
})

test('stops at max without requesting past it', async () => {
  const table = makeTable(7000)
  const { data, error } = await fetchAllPages(table.makeQuery, { max: 2500 })
  assert.equal(error, null)
  assert.equal(data.length, 2500)
  assert.deepEqual(
    table.calls.map((call) => call.range),
    [[0, 999], [1000, 1999], [2000, 2499]],
  )
})

test('caps at DEFAULT_MAX_ROWS when no max is given', async () => {
  const table = makeTable(6200)
  const { data } = await fetchAllPages(table.makeQuery)
  assert.equal(data.length, DEFAULT_MAX_ROWS)
  assert.equal(table.calls.length, 5)
})

test('an empty result is one query and an empty array', async () => {
  const table = makeTable(0)
  const { data, error } = await fetchAllPages(table.makeQuery)
  assert.equal(error, null)
  assert.deepEqual(data, [])
  assert.equal(table.calls.length, 1)
})

test('a failed page fails the whole read instead of returning a partial prefix', async () => {
  const table = makeTable(3000, { failOnCall: 2 })
  const { data, error } = await fetchAllPages(table.makeQuery)
  assert.equal(data, null)
  assert.deepEqual(error, { message: 'boom' })
  assert.equal(table.calls.length, 2)
})

test('a null data page is treated as empty and ends the read', async () => {
  const { data, error } = await fetchAllPages(() => ({
    range: () => Promise.resolve({ data: null, error: null }),
  }))
  assert.equal(error, null)
  assert.deepEqual(data, [])
})
