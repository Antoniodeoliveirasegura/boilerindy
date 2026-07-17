import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeHttpUrl, hostMatchesSuffix } from '../src/urlSafety.mjs'

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

test('assertSafeHttpUrl rejects IPv4-mapped IPv6 loopback', async () => {
  await assert.rejects(
    () => assertSafeHttpUrl('http://[::ffff:127.0.0.1]/feed.ics'),
    /not allowed/,
  )
})

test('assertSafeHttpUrl rejects IPv4-mapped IPv6 cloud metadata', async () => {
  await assert.rejects(
    () => assertSafeHttpUrl('http://[::ffff:169.254.169.254]/latest/meta-data/'),
    /not allowed/,
  )
})

test('assertSafeHttpUrl rejects plain IPv6 loopback', async () => {
  await assert.rejects(
    () => assertSafeHttpUrl('http://[::1]/feed.ics'),
    /not allowed/,
  )
})

test('assertSafeHttpUrl rejects credentials in the URL', async () => {
  await assert.rejects(
    () => assertSafeHttpUrl('https://user:pass@example.com/feed.ics'),
    /not allowed/,
  )
})

test('hostMatchesSuffix matches host and subdomains at a dot boundary only', () => {
  assert.equal(hostMatchesSuffix('purdue.edu', ['purdue.edu']), true)
  assert.equal(hostMatchesSuffix('selfservice.purdue.edu', ['purdue.edu']), true)
  assert.equal(hostMatchesSuffix('notpurdue.edu', ['purdue.edu']), false)
  assert.equal(hostMatchesSuffix('purdue.edu.evil.com', ['purdue.edu']), false)
})
