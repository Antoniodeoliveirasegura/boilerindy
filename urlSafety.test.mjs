import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeHttpUrl } from './urlSafety.mjs'

test('assertSafeHttpUrl rejects localhost', async () => {
  await assert.rejects(
    () => assertSafeHttpUrl('http://localhost/calendar.ics'),
    /not allowed/,
  )
})

test('assertSafeHttpUrl rejects private IPv4 literals', async () => {
  await assert.rejects(
    () => assertSafeHttpUrl('https://127.0.0.1/feed.ics'),
    /not allowed/,
  )
})

test('assertSafeHttpUrl rejects non-http schemes', async () => {
  await assert.rejects(
    () => assertSafeHttpUrl('file:///etc/passwd'),
    /Only http and https/,
  )
})
