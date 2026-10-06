import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { buildClubDirectory, parseClubSearchParams, searchClubDirectory } from '../../src/boilerlinkClubs.mjs'

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

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/boilerlink-organizations.json', import.meta.url), 'utf8'))
const DIRECTORY = buildClubDirectory(FIXTURE.value, { now: new Date('2026-09-08T12:00:00.000Z') })
const TRANSLOC = 'https://iuindianapolis.transloc.com/Services/JSONPRelay.svc'

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

async function withApp({ factory = createCampusPublicRouter, cached = {}, clubs } = {}, run) {
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
      publicReadIpRateLimit: limiter('public-read-ip'),
      publicReadRateLimit: limiter('public-read'),
      clubsReadRateLimit: limiter('clubs-read'),
      // server.mjs's getCached: answers from `cached` when the test supplies a
      // value for the key, otherwise runs the producer, as a cold cache would.
      getCached: async (key, ttlMs, producer) => {
        cacheCalls.push({ key, ttlMs })
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
  const cached = { 'transit:vehicles': [], 'transit:stops': [], 'transit:routes': [], 'parking:garages': { garages: [] } }
  await withApp({ cached }, async ({ base, limiterHits }) => {
    for (const path of ['/api/transit/vehicles', '/api/transit/stops', '/api/transit/routes', '/api/parking/garages', '/api/clubs']) {
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
          ['/api/transit/vehicles', 'GetMapVehiclePoints', 'public, max-age=10, s-maxage=10, stale-while-revalidate=20'],
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
          { key: 'transit:vehicles', ttlMs: 5 * 1000 },
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
        for (const path of ['/api/transit/vehicles', '/api/transit/stops', '/api/transit/routes']) {
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
