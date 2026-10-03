import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeHttpUrl, hostMatchesSuffix, safeFetchIcsText } from '../src/urlSafety.mjs'
import { isTransientFailure } from '../src/cronTick.mjs'

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

test('safeFetchIcsText keeps the status of a non-2xx feed answer, so a gateway status reads as transient', async () => {
  const realFetch = globalThis.fetch
  try {
    for (const [status, transient] of [[503, true], [502, true], [404, false], [401, false]]) {
      globalThis.fetch = async () => new Response('nope', { status })
      await assert.rejects(
        () => safeFetchIcsText('https://203.0.113.10/feed.ics'),
        (err) => {
          // classifyFetchError matches on this message, so it must not change.
          assert.equal(err.message, `Request failed with status ${status}`)
          assert.equal(err.status, status)
          assert.equal(isTransientFailure(err), transient)
          return true
        },
      )
    }
  } finally {
    globalThis.fetch = realFetch
  }
})
