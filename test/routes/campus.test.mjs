import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { buildClubDirectory, parseClubSearchParams, searchClubDirectory } from '../../src/boilerlinkClubs.mjs'
import { buildTransitIndex, publicPlace } from '../../src/transitPlaces.mjs'
import { createStaleCache } from '../../src/upstreamFetch.mjs'

// Issue #191: the campus public reads as a feature router, booted on a small
// app with recording limiters, a recording stand-in for server.mjs's shared
// TTL cache, a fake TransLoc behind globalThis.fetch and a club directory
// built from the BoilerLink fixture.
//
// src/routes/campus.mjs reads TRANSLOC_API_KEY when it loads, as server.mjs
// did, so each configuration gets its own module instance.
process.env.TRANSLOC_API_KEY = 'transloc-test-key'
delete process.env.PARKING_STATUS_CACHE_MS
const { createCampusPublicRouter } = await import('../../src/routes/campus.mjs')
delete process.env.TRANSLOC_API_KEY
const { createCampusPublicRouter: createUnconfiguredRouter } = await import('../../src/routes/campus.mjs?no-transloc-key')

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'))
const FIXTURE = load('boilerlink-organizations.json')
const DIRECTORY = buildClubDirectory(FIXTURE.value, { now: new Date('2026-09-08T12:00:00.000Z') })
const TRANSLOC = 'https://iuindianapolis.transloc.com/Services/JSONPRelay.svc'
// The JagLine stops and routes feeds of 2026-10-29, and its trimmed
// GetStopArrivalTimes answer of 2026-10-30 (see test/transitArrivals.test.mjs).
const STOPS = load('transloc-stops.json')
const ROUTES = load('transloc-routes.json')
const ARRIVALS = load('transloc-stop-arrival-times.json')
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
// An Orange bus at Michigan and Blackford: five stops from Riverwalk Apartments.
const ORANGE_AT_BLACKFORD = { VehicleID: 41, RouteID: 34, Latitude: 39.774493, Longitude: -86.170475, IsOnRoute: true }

// globalThis.fetch as TransLoc: records each URL and answers `respond(url)`.
async function withFakeTransloc(respond, run) {
  const realFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init)
    urls.push(String(url))
    return respond(String(url))
  }
  try {
    await run(urls)
  } finally {
    globalThis.fetch = realFetch
  }
}

async function withApp({ factory = createCampusPublicRouter, cached = {}, cache, clubs } = {}, run) {
  const limiterHits = []
  const cacheCalls = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.path}`)
    next()
  }
  const app = express()
  app.use(
    factory({
      transitVehiclesIpRateLimit: limiter('transit-vehicles-ip'),
      transitVehiclesRateLimit: limiter('transit-vehicles'),
      widgetReadIpRateLimit: limiter('widget-read-ip'),
      widgetReadRateLimit: limiter('widget-read'),
      publicReadIpRateLimit: limiter('public-read-ip'),
      publicReadRateLimit: limiter('public-read'),
      clubsReadRateLimit: limiter('clubs-read'),
      // server.mjs's getCached: answers from `cached` when the test supplies a
      // value for the key, otherwise runs the producer, as a cold cache would.
      // A test can hand in a real cache (`cache`) instead.
      getCached: async (key, ttlMs, producer) => {
        cacheCalls.push({ key, ttlMs })
        if (cache) return cache.get(key, ttlMs, producer)
        if (key in cached) {
          const value = cached[key]
          if (value instanceof Error) throw value
          return value
        }
        return producer()
      },
      clubDirectoryCache: clubs ?? { get: async () => ({ directory: DIRECTORY, stale: false }) },
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await run({ base, limiterHits, cacheCalls })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('each route runs through its own limiters, the per-address cap first', async () => {
  const cached = {
    'transit:vehicles': { fetchedAt: Date.now(), rows: [] },
    'transit:stops': STOPS,
    'transit:routes': ROUTES,
    'transit:arrivals:riverwalk-apartments': { arrivals: [] },
    'parking:garages': { garages: [] },
  }
  await withApp({ cached }, async ({ base, limiterHits }) => {
    const paths = [
      '/api/transit/vehicles',
      '/api/transit/stops',
      '/api/transit/routes',
      '/api/transit/places',
      '/api/transit/arrivals?stop=riverwalk-apartments',
      '/api/parking/garages',
      '/api/clubs',
    ]
    for (const path of paths) {
      const res = await fetch(base + path)
      assert.equal(res.status, 200, path)
    }
    assert.deepEqual(limiterHits, [
      'transit-vehicles-ip /api/transit/vehicles',
      'transit-vehicles /api/transit/vehicles',
      'public-read-ip /api/transit/stops',
      'public-read /api/transit/stops',
      'public-read-ip /api/transit/routes',
      'public-read /api/transit/routes',
      'public-read-ip /api/transit/places',
      'public-read /api/transit/places',
      'widget-read-ip /api/transit/arrivals',
      'widget-read /api/transit/arrivals',
      'public-read-ip /api/parking/garages',
      'public-read /api/parking/garages',
      'clubs-read /api/clubs',
    ])
  })
})

test('the transit routes proxy TransLoc with the key through the shared cache and set the edge headers', async () => {
  await withFakeTransloc(
    (url) => new Response(JSON.stringify({ from: url.split('?')[0].split('/').pop() }), { status: 200, headers: { 'content-type': 'application/json' } }),
    async (urls) => {
      await withApp({}, async ({ base, cacheCalls }) => {
        const expected = [
          ['/api/transit/vehicles', 'GetMapVehiclePoints', 'public, max-age=4, s-maxage=4, stale-while-revalidate=8'],
          ['/api/transit/stops', 'GetStops', 'public, max-age=60, s-maxage=600, stale-while-revalidate=600'],
          ['/api/transit/routes', 'GetRoutes', 'public, max-age=60, s-maxage=600, stale-while-revalidate=600'],
        ]
        for (const [path, endpoint, cacheControl] of expected) {
          const res = await fetch(base + path)
          assert.equal(res.status, 200, path)
          assert.deepEqual(await res.json(), { from: endpoint })
          assert.equal(res.headers.get('cache-control'), cacheControl, path)
        }
        assert.deepEqual(urls, [
          `${TRANSLOC}/GetMapVehiclePoints?apiKey=transloc-test-key&isPublicMap=true`,
          `${TRANSLOC}/GetStops?apiKey=transloc-test-key`,
          `${TRANSLOC}/GetRoutes?apiKey=transloc-test-key`,
        ])
        assert.deepEqual(cacheCalls, [
          { key: 'transit:vehicles', ttlMs: 4 * 1000 },
          { key: 'transit:stops', ttlMs: 10 * 60 * 1000 },
          { key: 'transit:routes', ttlMs: 10 * 60 * 1000 },
        ])
      })
    },
  )
})

test('without TRANSLOC_API_KEY the transit routes answer 503 and never reach TransLoc or the cache', async () => {
  await withFakeTransloc(
    () => {
      throw new Error('TransLoc must not be called')
    },
    async (urls) => {
      await withApp({ factory: createUnconfiguredRouter }, async ({ base, cacheCalls }) => {
        const paths = ['/api/transit/vehicles', '/api/transit/stops', '/api/transit/routes', '/api/transit/places', '/api/transit/arrivals?stop=riverwalk-apartments']
        for (const path of paths) {
          const res = await fetch(base + path)
          assert.equal(res.status, 503, path)
          assert.deepEqual(await res.json(), { error: { message: 'Transit is not configured.', status: 503 } })
        }
        assert.deepEqual(urls, [])
        assert.deepEqual(cacheCalls, [])
      })
    },
  )
})

test('a TransLoc failure answers 502 when the upstream failed and 500 for anything else', async () => {
  await withFakeTransloc(
    () => new Response('Service Unavailable', { status: 503 }),
    async () => {
      await withApp({ cached: { 'transit:stops': new Error('cache broke') } }, async ({ base }) => {
        const upstream = await fetch(`${base}/api/transit/vehicles`)
        assert.equal(upstream.status, 502)
        assert.deepEqual(await upstream.json(), { error: { message: 'Transit data is temporarily unavailable.', status: 502 } })

        const other = await fetch(`${base}/api/transit/stops`)
        assert.equal(other.status, 500)
        assert.deepEqual(await other.json(), { error: { message: 'Failed to fetch stops data.', status: 500 } })
      })
    },
  )
})

test('vehicles: while TransLoc is down the last good copy goes out with each Seconds grown by its age', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T12:43:39Z') })
  let up = true
  const cache = createStaleCache({ log: { warn() {} } })
  // Two buses that last reported 15 and 9 s before TransLoc answered.
  const rows = [{ ...ORANGE_AT_BLACKFORD, Seconds: 15 }, { VehicleID: 5, RouteID: 33, Latitude: 39.76941, Longitude: -86.17134, IsOnRoute: true, Seconds: 9 }]
  await withFakeTransloc(
    () => (up ? json(rows) : new Response('Service Unavailable', { status: 503 })),
    async (urls) => {
      await withApp({ cache }, async ({ base }) => {
        const read = async () => (await fetch(`${base}/api/transit/vehicles`)).json()
        assert.deepEqual(await read(), rows)

        up = false
        t.mock.timers.tick(3 * 60 * 1000)
        const sent = await read()
        assert.equal(urls.length, 2, 'TransLoc was asked again')
        assert.deepEqual(sent.map((row) => row.Seconds), [195, 189])
        assert.deepEqual(sent.map(({ Seconds, ...rest }) => rest), rows.map(({ Seconds, ...rest }) => rest))
        // The cached copy keeps TransLoc's own Seconds for the next request.
        assert.deepEqual(cache.peek('transit:vehicles').rows.map((row) => row.Seconds), [15, 9])
      })
    },
  )
})

// ── The widget reads (issue #549) ──────────────────────────────────────────

test('places lists the stops grouped into places, from the cached stops and routes feeds', async () => {
  await withApp({ cached: { 'transit:stops': STOPS, 'transit:routes': ROUTES } }, async ({ base, cacheCalls }) => {
    const res = await fetch(`${base}/api/transit/places`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60, s-maxage=600, stale-while-revalidate=600')
    assert.equal(res.headers.get('set-cookie'), null)
    const { places } = await res.json()
    assert.deepEqual(places, buildTransitIndex(STOPS, ROUTES).places.map(publicPlace))
    assert.equal(places.length, 41)
    assert.deepEqual(places.find((p) => p.key === 'riverwalk-apartments').routes.map((r) => r.routeName), ['Crimson', 'Gray', 'Orange'])
    assert.ok(places.every((p) => !('stops' in p)))
    assert.deepEqual(cacheCalls, [
      { key: 'transit:stops', ttlMs: 10 * 60 * 1000 },
      { key: 'transit:routes', ttlMs: 10 * 60 * 1000 },
    ])
  })
})

test('arrivals: a bad or unknown stop answers 400 or 404, never stored, without asking TransLoc for arrivals', async () => {
  await withFakeTransloc(
    () => {
      throw new Error('TransLoc must not be called')
    },
    async (urls) => {
      await withApp({ cached: { 'transit:stops': STOPS, 'transit:routes': ROUTES } }, async ({ base }) => {
        for (const query of ['', '?stop=', '?stop=riverwalk%20apartments', '?stop=a&stop=b']) {
          const res = await fetch(`${base}/api/transit/arrivals${query}`)
          assert.equal(res.status, 400, query)
          assert.equal(res.headers.get('cache-control'), 'no-store')
          assert.deepEqual(await res.json(), { error: { message: 'Pick a stop from the list.', status: 400, code: 'transit_bad_stop' } })
        }
        const unknown = await fetch(`${base}/api/transit/arrivals?stop=nowhere-and-nothing`)
        assert.equal(unknown.status, 404)
        assert.equal(unknown.headers.get('cache-control'), 'no-store')
        assert.equal((await unknown.json()).error.code, 'transit_stop_not_found')
        assert.deepEqual(urls, [])
      })
    },
  )
})

test('arrivals: TransLoc\'s estimates for the place\'s route stops, positions for the rest, cached 15 s per place', async () => {
  await withFakeTransloc(
    (url) => (url.includes('/GetStopArrivalTimes?') ? json(ARRIVALS) : json([ORANGE_AT_BLACKFORD])),
    async (urls) => {
      await withApp({ cached: { 'transit:stops': STOPS, 'transit:routes': ROUTES } }, async ({ base, cacheCalls }) => {
        const res = await fetch(`${base}/api/transit/arrivals?stop=Riverwalk-Apartments`)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('cache-control'), 'public, max-age=15')
        assert.equal(res.headers.get('set-cookie'), null)
        const answer = await res.json()
        assert.equal(answer.place.key, 'riverwalk-apartments')
        assert.match(answer.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
        const seconds = (at) => (Date.parse(at) - Date.parse(answer.fetchedAt)) / 1000
        // The relay answers every row; only Riverwalk Apartments' count.
        assert.deepEqual(
          answer.arrivals.map((a) => [a.routeNum, a.routeName, seconds(a.at), a.source]),
          [
            ['7', 'Orange', 600, 'position'],
            ['2', 'Gray', 607, 'transloc'],
            ['1', 'Crimson', 677, 'transloc'],
          ],
        )
        assert.deepEqual(urls.sort(), [
          `${TRANSLOC}/GetMapVehiclePoints?apiKey=transloc-test-key&isPublicMap=true`,
          `${TRANSLOC}/GetStopArrivalTimes?apiKey=transloc-test-key&routeStopIDs=243,369,409&timesPerStop=2`,
        ])
        assert.deepEqual(
          cacheCalls.filter((call) => call.key.startsWith('transit:arrivals') || call.key === 'transit:vehicles'),
          [
            { key: 'transit:arrivals:riverwalk-apartments', ttlMs: 15 * 1000 },
            { key: 'transit:vehicles', ttlMs: 4 * 1000 },
          ],
        )
      })
    },
  )
})

test('arrivals: estimates the relay will not give or the parser cannot read leave every route to the positions, logged once', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  // The relay's answer without a usable key: 200 with an empty body.
  await withFakeTransloc(
    (url) => (url.includes('/GetStopArrivalTimes?') ? new Response('', { status: 200 }) : json([ORANGE_AT_BLACKFORD])),
    async () => {
      await withApp({ cached: { 'transit:stops': STOPS, 'transit:routes': ROUTES } }, async ({ base }) => {
        for (const stop of ['riverwalk-apartments', 'michigan-and-university']) {
          const res = await fetch(`${base}/api/transit/arrivals?stop=${stop}`)
          assert.equal(res.status, 200)
          const { arrivals } = await res.json()
          assert.ok(arrivals.every((a) => a.source === 'position'), stop)
          assert.ok(arrivals.some((a) => a.routeName === 'Orange'), stop)
        }
      })
    },
  )
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /no estimates \(TransLoc responded 200: invalid JSON body\)/)

  // Times in a shape the parser does not know.
  await withFakeTransloc(
    (url) => (url.includes('/GetStopArrivalTimes?') ? json([{ RouteId: 31, RouteStopId: 369, Times: [{ Minutes: 4 }] }]) : json([])),
    async () => {
      await withApp({ cached: { 'transit:stops': STOPS, 'transit:routes': ROUTES } }, async ({ base }) => {
        const res = await fetch(`${base}/api/transit/arrivals?stop=riverwalk-apartments`)
        assert.deepEqual((await res.json()).arrivals, [])
      })
    },
  )
  assert.equal(warn.mock.callCount(), 2)
  assert.match(warn.mock.calls[1].arguments[0], /shape the parser does not read/)
})

test('arrivals: with TransLoc down and no answer yet, 503 never stored; a bug answers 500', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const errorLog = t.mock.method(console, 'error', () => {})
  await withFakeTransloc(
    () => new Response('Service Unavailable', { status: 503 }),
    async () => {
      await withApp({ cached: { 'transit:stops': STOPS, 'transit:routes': ROUTES } }, async ({ base }) => {
        const res = await fetch(`${base}/api/transit/arrivals?stop=riverwalk-apartments`)
        assert.equal(res.status, 503)
        assert.equal(res.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await res.json(), { error: { message: 'Bus times are not available right now.', status: 503, code: 'transit_unavailable' } })
      })
      await withApp({ cached: { 'transit:stops': new Error('cache broke'), 'transit:routes': ROUTES } }, async ({ base }) => {
        const res = await fetch(`${base}/api/transit/arrivals?stop=riverwalk-apartments`)
        assert.equal(res.status, 500)
        assert.equal((await res.json()).error.code, 'transit_internal')
        const places = await fetch(`${base}/api/transit/places`)
        assert.equal(places.status, 500)
        assert.deepEqual(await places.json(), { error: { message: 'Failed to fetch places data.', status: 500 } })
      })
    },
  )
  assert.equal(errorLog.mock.callCount(), 2)
})

test('arrivals: while TransLoc is down the last good answer keeps serving, with its fetchedAt', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T10:40:26Z') })
  t.mock.method(console, 'warn', () => {})
  let up = true
  const cache = createStaleCache({ log: { warn() {} } })
  await withFakeTransloc(
    (url) => {
      if (!up) return new Response('Service Unavailable', { status: 503 })
      if (url.includes('/GetStops?')) return json(STOPS)
      if (url.includes('/GetRoutes?')) return json(ROUTES)
      return url.includes('/GetStopArrivalTimes?') ? json(ARRIVALS) : json([ORANGE_AT_BLACKFORD])
    },
    async (urls) => {
      await withApp({ cache }, async ({ base }) => {
        const first = await (await fetch(`${base}/api/transit/arrivals?stop=riverwalk-apartments`)).json()
        assert.equal(first.fetchedAt, '2026-10-30T10:40:26Z')
        assert.equal(first.arrivals.length, 3)

        // Within 15 s the cached answer is served without asking TransLoc.
        const asked = urls.length
        t.mock.timers.tick(10 * 1000)
        assert.deepEqual(await (await fetch(`${base}/api/transit/arrivals?stop=riverwalk-apartments`)).json(), first)
        assert.equal(urls.length, asked)

        // TransLoc goes down; a minute on, the last bus positions are too old to use.
        up = false
        t.mock.timers.tick(61 * 1000)
        const res = await fetch(`${base}/api/transit/arrivals?stop=riverwalk-apartments`)
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), first)
        assert.ok(urls.length > asked, 'TransLoc was asked again')
      })
    },
  )
})

test('parking serves the cached snapshot with a short public lifetime', async () => {
  const snapshot = { status: 'ok', garages: [{ id: 'blackford', available: 120 }] }
  await withApp({ cached: { 'parking:garages': snapshot } }, async ({ base, cacheCalls }) => {
    const res = await fetch(`${base}/api/parking/garages`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), snapshot)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=15, s-maxage=30')
    assert.deepEqual(cacheCalls, [{ key: 'parking:garages', ttlMs: 60_000 }])
  })
  await withApp({ cached: { 'parking:garages': new Error('parser broke') } }, async ({ base }) => {
    const res = await fetch(`${base}/api/parking/garages`)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'Failed to fetch parking status' })
  })
})

test('campus news serves The Circuit\'s headlines through the public-read limiters, cached for an hour (issue #470)', async () => {
  const news = { ok: true, source: 'The Circuit', site: 'https://circuitpress.org/', fetchedAt: '2026-10-17T06:30:00.000Z', posts: [{ title: 'Launch', url: 'https://circuitpress.org/launch/' }] }
  await withApp({ cached: { 'news:circuit': news } }, async ({ base, limiterHits, cacheCalls }) => {
    const res = await fetch(`${base}/api/campus-news`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), news)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=600, s-maxage=1800')
    assert.equal(res.headers.get('set-cookie'), null)
    assert.deepEqual(cacheCalls, [{ key: 'news:circuit', ttlMs: 60 * 60 * 1000 }])
    assert.deepEqual(limiterHits, ['public-read-ip /api/campus-news', 'public-read /api/campus-news'])
  })
})

test('with the feed down and nothing cached, campus news answers an empty list, never cached, and leaves the feed alone for a while', async (t) => {
  t.mock.method(console, 'warn', () => {})
  await withApp({ cached: { 'news:circuit': new Error('The Circuit feed answered 503') } }, async ({ base, cacheCalls }) => {
    const res = await fetch(`${base}/api/campus-news`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await res.json(), { ok: false, error: 'campus_news_unavailable', posts: [] })
    // The next read inside the five-minute wait answers the same without asking the feed.
    const again = await fetch(`${base}/api/campus-news`)
    assert.deepEqual(await again.json(), { ok: false, error: 'campus_news_unavailable', posts: [] })
    assert.equal(cacheCalls.length, 1)
  })
})

test('clubs search the injected directory and are cached for five minutes', async () => {
  await withApp({ clubs: { get: async () => ({ directory: DIRECTORY, stale: true }) } }, async ({ base }) => {
    const query = { q: 'club', scope: 'all', page: '1', pageSize: '5' }
    const res = await fetch(`${base}/api/clubs?${new URLSearchParams(query)}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300')
    assert.deepEqual(await res.json(), searchClubDirectory(DIRECTORY, parseClubSearchParams(query), { stale: true }))
  })
  const broken = {
    get: async () => {
      throw new Error('directory broke')
    },
  }
  await withApp({ clubs: broken }, async ({ base }) => {
    const res = await fetch(`${base}/api/clubs`)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'Failed to load the club directory' })
  })
})
