import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import http from 'node:http'
import { gzipSync } from 'node:zlib'
import {
  FEED_TOO_LARGE,
  FeedRefusedError,
  MAX_FEED_BYTES,
  PROVIDER_NOT_ALLOWED,
  assertSafeHttpUrl,
  hostMatchesSuffix,
  safeFetchIcsText,
} from '../src/urlSafety.mjs'
import { isTransientFailure } from '../src/cronTick.mjs'

const BRIGHTSPACE_HOSTS = ['brightspace.com', 'd2l.com', 'desire2learn.com']
const FEED_URL = 'https://purdue.brightspace.com/d2l/le/calendar/feed/user/feed.ics?token=feed-token'

// fetch answers from `answer(url, init, realFetch)` and every lookup gets a
// TEST-NET address, so assertSafeHttpUrl runs for real without a resolver.
// Both are recorded and put back when the test is done.
async function withFeedHost(answer, run) {
  const realFetch = globalThis.fetch
  const fetched = []
  const lookups = []
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url))
    return answer(String(url), init, realFetch)
  }
  const lookup = mock.method(dns, 'lookup', async (hostname) => {
    lookups.push(hostname)
    return [{ address: '192.0.2.10', family: 4 }]
  })
  try {
    await run({ fetched, lookups })
  } finally {
    globalThis.fetch = realFetch
    lookup.mock.restore()
  }
}

const refused = (message) => (err) => {
  assert.ok(err instanceof FeedRefusedError, `${err?.name}: ${err?.message}`)
  assert.equal(err.message, message)
  assert.equal(isTransientFailure(err), false)
  return true
}

// A body of `size` bytes of 'X' served in 1 MiB chunks, recording how many
// chunks were pulled and whether the reader cancelled the rest.
function countedBody(size) {
  const seen = { pulls: 0, cancelled: false }
  const chunk = 1024 * 1024
  let sent = 0
  const stream = new ReadableStream({
    pull(controller) {
      seen.pulls += 1
      if (sent >= size) return controller.close()
      const length = Math.min(chunk, size - sent)
      sent += length
      controller.enqueue(new Uint8Array(length).fill(0x58))
    },
    cancel() {
      seen.cancelled = true
    },
  })
  return { stream, seen }
}

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
  for (const [status, transient] of [[503, true], [502, true], [404, false], [401, false]]) {
    await withFeedHost(() => new Response('nope', { status }), async () => {
      await assert.rejects(
        () => safeFetchIcsText(FEED_URL, { allowedHosts: BRIGHTSPACE_HOSTS }),
        (err) => {
          // classifyFetchError matches on this message, so it must not change.
          assert.equal(err.message, `Request failed with status ${status}`)
          assert.equal(err.status, status)
          assert.equal(isTransientFailure(err), transient)
          return true
        },
      )
    })
  }
})

test("safeFetchIcsText needs the provider's hosts, and refuses a link off them before any lookup or fetch", async () => {
  await withFeedHost(() => assert.fail('nothing may be fetched'), async ({ fetched, lookups }) => {
    await assert.rejects(() => safeFetchIcsText(FEED_URL), /needs the provider host allowlist/)
    await assert.rejects(() => safeFetchIcsText(FEED_URL, { allowedHosts: [] }), /needs the provider host allowlist/)
    // A link stored before the allowlist was enforced is refused the same way.
    for (const url of ['https://calendar.example.com/feed.ics', 'https://brightspace.com.example.com/feed.ics', 'https://203.0.113.10/feed.ics']) {
      await assert.rejects(() => safeFetchIcsText(url, { allowedHosts: BRIGHTSPACE_HOSTS }), refused(PROVIDER_NOT_ALLOWED), url)
    }
    assert.deepEqual(fetched, [])
    assert.deepEqual(lookups, [])
  })
})

test("a redirect must stay on the provider's hosts: a hop anywhere else is refused before it is looked up or fetched", async () => {
  // A hop to a host that only DNS vouches for: with the allowlist checked at
  // creation alone, this was looked up, then fetched by name, so a TTL-0 name
  // could answer the check with a public address and the fetch with an
  // internal one.
  const offList = (url) =>
    url === FEED_URL
      ? new Response('moved', { status: 302, headers: { location: 'http://unlisted.example:8080/probe' } })
      : new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 })
  await withFeedHost(offList, async ({ fetched, lookups }) => {
    await assert.rejects(() => safeFetchIcsText(FEED_URL, { allowedHosts: BRIGHTSPACE_HOSTS }), refused(PROVIDER_NOT_ALLOWED))
    assert.deepEqual(fetched, [FEED_URL])
    assert.deepEqual(lookups, ['purdue.brightspace.com'])
  })

  // A hop to another of the provider's hosts, or a relative one, is followed.
  const onList = (url) => {
    if (url === FEED_URL) return new Response('', { status: 301, headers: { location: 'https://purdue.d2l.com/feed.ics' } })
    if (url === 'https://purdue.d2l.com/feed.ics') return new Response('', { status: 307, headers: { location: '/calendar/feed.ics' } })
    return new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 })
  }
  await withFeedHost(onList, async ({ fetched, lookups }) => {
    assert.equal(await safeFetchIcsText(FEED_URL, { allowedHosts: BRIGHTSPACE_HOSTS }), 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    assert.deepEqual(fetched, [FEED_URL, 'https://purdue.d2l.com/feed.ics', 'https://purdue.d2l.com/calendar/feed.ics'])
    assert.deepEqual(lookups, ['purdue.brightspace.com', 'purdue.d2l.com', 'purdue.d2l.com'])
  })
})

test('a feed body is read no further than 5 MB', async () => {
  assert.equal(MAX_FEED_BYTES, 5 * 1024 * 1024)
  const fetchFeed = () => safeFetchIcsText(FEED_URL, { allowedHosts: BRIGHTSPACE_HOSTS })

  // A declared length over the limit: refused before a byte is read.
  const declared = countedBody(MAX_FEED_BYTES + 1)
  await withFeedHost(() => new Response(declared.stream, { status: 200, headers: { 'content-length': String(MAX_FEED_BYTES + 1) } }), async () => {
    await assert.rejects(fetchFeed, refused(FEED_TOO_LARGE))
  })
  assert.ok(declared.seen.pulls <= 1, `pulled ${declared.seen.pulls} chunks`)
  assert.equal(declared.seen.cancelled, true)

  // No declared length: reading stops one chunk past the limit and the rest
  // of the stream is cancelled, so a body with no end is never held whole.
  const endless = countedBody(Number.MAX_SAFE_INTEGER)
  await withFeedHost(() => new Response(endless.stream, { status: 200 }), async () => {
    await assert.rejects(fetchFeed, refused(FEED_TOO_LARGE))
  })
  assert.ok(endless.seen.pulls <= 8, `pulled ${endless.seen.pulls} chunks`)
  assert.equal(endless.seen.cancelled, true)

  // Exactly the limit is read, and a leading byte order mark is dropped as
  // res.text() did.
  const atLimit = countedBody(MAX_FEED_BYTES)
  await withFeedHost(() => new Response(atLimit.stream, { status: 200 }), async () => {
    assert.equal((await fetchFeed()).length, MAX_FEED_BYTES)
  })
  await withFeedHost(() => new Response('﻿BEGIN:VCALENDAR', { status: 200 }), async () => {
    assert.equal(await fetchFeed(), 'BEGIN:VCALENDAR')
  })
})

test('the 5 MB limit counts decoded bytes, so a small gzip body that inflates past it is refused', async () => {
  // A real HTTP answer on loopback, so fetch itself inflates the body.
  const inflated = Buffer.alloc(MAX_FEED_BYTES + 1024 * 1024, 'X')
  const bodies = { '/bomb': gzipSync(inflated), '/small': gzipSync(Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')) }
  assert.ok(bodies['/bomb'].length < 64 * 1024, `gzip body is ${bodies['/bomb'].length} bytes`)
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' })
    res.end(bodies[req.url])
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const local = `http://127.0.0.1:${server.address().port}`
  try {
    for (const [path, expected] of [['/bomb', null], ['/small', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n']]) {
      await withFeedHost((_url, init, realFetch) => realFetch(local + path, init), async () => {
        const fetchFeed = () => safeFetchIcsText(FEED_URL, { allowedHosts: BRIGHTSPACE_HOSTS })
        if (expected === null) await assert.rejects(fetchFeed, refused(FEED_TOO_LARGE))
        else assert.equal(await fetchFeed(), expected)
      })
    }
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
