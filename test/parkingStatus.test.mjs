// Tests for the parking-status module (issue #14). The parser is pure: HTML
// from IU Parking's public lot-count page goes in, a normalized snapshot comes
// out. The fetch shell is exercised with an injected fetch, so no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  GARAGES,
  PERMIT_INFO,
  classifyGarage,
  indyLocalToIso,
  parseLotCountHtml,
  buildSnapshot,
  degradedSnapshot,
  fetchParkingStatus,
} from '../src/parkingStatus.mjs'

const FIXTURE = readFileSync(new URL('./fixtures/inpark-lotcount.html', import.meta.url), 'utf8')
// A few minutes after the fixture's own timestamps (9/4/2026 2:46 AM Indianapolis, EDT).
const NOW = new Date('2026-09-04T06:50:00.000Z')

const byId = (snapshot) => Object.fromEntries(snapshot.garages.map((g) => [g.id, g]))

test('parses every garage block from the real page', () => {
  const parsed = parseLotCountHtml(FIXTURE)
  assert.equal(parsed.length, 6)
  assert.deepEqual(
    parsed.map((g) => g.name),
    ['Blackford Garage', 'Barnhill Garage', 'Gateway Garage', 'Riverwalk Garage', 'Sports Garage', 'Lockefield Student Garage'],
  )
  const blackford = parsed[0]
  assert.equal(blackford.address, '725 W Michigan St')
  assert.equal(blackford.rates, 'ST Permit Required')
  assert.equal(blackford.capacity, 1143)
  assert.equal(blackford.occupied, 168)
  assert.equal(blackford.available, 975)
  assert.equal(blackford.timestampText, '9/4/2026 2:46:41 AM')
  // Coordinates and the status icon come from the page's marker JSON.
  assert.ok(Math.abs(blackford.lat - 39.7751) < 0.001)
  assert.ok(Math.abs(blackford.lng - -86.1706) < 0.001)
  assert.equal(blackford.icon, 'icon-10P')
})

test('buildSnapshot maps garages onto the static table and normalizes counts', () => {
  const snap = buildSnapshot(FIXTURE, { now: NOW })
  assert.equal(snap.ok, true)
  assert.equal(snap.fetchedAt, NOW.toISOString())
  const g = byId(snap)
  assert.deepEqual(Object.keys(g).sort(), ['barnhill', 'blackford', 'gateway', 'lockefield', 'riverwalk', 'sports'])

  // Straightforward garage: counts pass through, percent + status derived.
  assert.equal(g.gateway.capacity, 1333)
  assert.equal(g.gateway.occupied, 955)
  assert.equal(g.gateway.available, 378)
  assert.equal(g.gateway.percentFull, 72)
  assert.equal(g.gateway.status, 'busy')
  assert.equal(g.gateway.code, 'XL')

  // Sensor drift: the page reports Occupied -1 / Available 484 on a 483-space
  // garage. Occupied is clamped to 0 and available recomputed from capacity.
  assert.equal(g.lockefield.occupied, 0)
  assert.equal(g.lockefield.available, 483)
  assert.equal(g.lockefield.percentFull, 0)
  assert.equal(g.lockefield.status, 'open')

  // No counts at all (only a "Full" icon at 2:46 AM): that is missing data,
  // not a full garage.
  assert.equal(g.barnhill.occupied, null)
  assert.equal(g.barnhill.available, null)
  assert.equal(g.barnhill.percentFull, null)
  assert.equal(g.barnhill.status, 'unknown')
  assert.equal(g.barnhill.icon, 'icon-Full')
  assert.equal(g.barnhill.capacity, 1324)

  // Timestamps are Indianapolis local time on the page; the snapshot carries ISO.
  assert.equal(g.blackford.updatedAt, '2026-09-04T06:46:41.000Z')
  assert.equal(g.blackford.stale, false)

  // Available never exceeds capacity for any garage.
  for (const garage of snap.garages) {
    if (garage.available != null) assert.ok(garage.available <= garage.capacity, garage.id)
  }
  // Known garages first, most available first; unknown last.
  const order = snap.garages.map((x) => x.id)
  assert.equal(order[order.length - 1], 'barnhill')
  assert.deepEqual(order.slice(0, 2), ['riverwalk', 'blackford'])
  // Permit rules ride along so the client has one source of truth.
  assert.equal(snap.permits, PERMIT_INFO)
})

test('marks counts stale when the page timestamp is old', () => {
  const later = new Date('2026-09-04T08:30:00.000Z') // ~1h45m after the page timestamps
  const snap = buildSnapshot(FIXTURE, { now: later })
  assert.equal(byId(snap).blackford.stale, true)
})

test('classifyGarage thresholds', () => {
  assert.equal(classifyGarage({ capacity: 1000, occupied: null }), 'unknown')
  assert.equal(classifyGarage({ capacity: 1000, occupied: 100 }), 'open')
  assert.equal(classifyGarage({ capacity: 1000, occupied: 699 }), 'open')
  assert.equal(classifyGarage({ capacity: 1000, occupied: 700 }), 'busy')
  assert.equal(classifyGarage({ capacity: 1000, occupied: 899 }), 'busy')
  assert.equal(classifyGarage({ capacity: 1000, occupied: 900 }), 'full')
  assert.equal(classifyGarage({ capacity: 100, occupied: 92 }), 'full') // 8 left
  assert.equal(classifyGarage({ capacity: 0, occupied: 0 }), 'unknown')
})

test('indyLocalToIso converts the page timestamp format in both DST states', () => {
  assert.equal(indyLocalToIso('9/4/2026 2:46:41 AM'), '2026-09-04T06:46:41.000Z') // EDT, UTC-4
  assert.equal(indyLocalToIso('1/15/2026 11:05:09 PM'), '2026-01-16T04:05:09.000Z') // EST, UTC-5
  assert.equal(indyLocalToIso('12/1/2026 12:00:00 PM'), '2026-12-01T17:00:00.000Z') // noon
  assert.equal(indyLocalToIso('12/1/2026 12:30:00 AM'), '2026-12-01T05:30:00.000Z') // half past midnight
  assert.equal(indyLocalToIso('not a timestamp'), null)
  assert.equal(indyLocalToIso(''), null)
})

test('garages without a matching marker still get coordinates from the static table', () => {
  const noMarkers = FIXTURE.replace(/markers:\[[\s\S]*?\]\s*,/, 'markers:[],')
  const snap = buildSnapshot(noMarkers, { now: NOW })
  const g = byId(snap)
  assert.equal(snap.ok, true)
  assert.ok(typeof g.sports.lat === 'number' && typeof g.sports.lng === 'number')
  assert.equal(g.sports.icon, null)
})

test('a page with no garage blocks is reported as a format change, not an empty lot list', () => {
  const snap = buildSnapshot('<html><body>Maintenance</body></html>', { now: NOW })
  assert.equal(snap.ok, false)
  assert.equal(snap.error, 'no-garages')
  assert.equal(snap.garages.length, GARAGES.length)
  assert.ok(snap.garages.every((g) => g.status === 'unknown'))
})

test('degradedSnapshot returns the static garages with unknown status', () => {
  const snap = degradedSnapshot('timeout', NOW)
  assert.equal(snap.ok, false)
  assert.equal(snap.error, 'timeout')
  assert.equal(snap.garages.length, 6)
  for (const g of snap.garages) {
    assert.equal(g.status, 'unknown')
    assert.equal(g.available, null)
    assert.ok(g.address)
    assert.ok(typeof g.lat === 'number')
  }
  assert.equal(snap.permits, PERMIT_INFO)
})

test('fetchParkingStatus parses a good response and degrades on failure', async () => {
  const okFetch = async () => ({ ok: true, status: 200, text: async () => FIXTURE })
  const good = await fetchParkingStatus({ fetchImpl: okFetch, now: NOW })
  assert.equal(good.ok, true)
  assert.equal(good.garages.length, 6)

  const badStatus = async () => ({ ok: false, status: 503, text: async () => 'nope' })
  const degraded = await fetchParkingStatus({ fetchImpl: badStatus, now: NOW })
  assert.equal(degraded.ok, false)
  assert.equal(degraded.error, 'http-503')
  assert.equal(degraded.garages.length, 6)

  const throwing = async () => { throw new Error('ECONNRESET') }
  const failed = await fetchParkingStatus({ fetchImpl: throwing, now: NOW })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /ECONNRESET/)
})

test('static tables are internally consistent', () => {
  assert.equal(GARAGES.length, 6)
  assert.equal(new Set(GARAGES.map((g) => g.id)).size, 6)
  for (const g of GARAGES) {
    assert.ok(g.name && g.address && g.code, g.id)
    assert.ok(g.lat > 39.7 && g.lat < 39.8 && g.lng < -86.1 && g.lng > -86.2, `${g.id} is on campus`)
  }
  assert.ok(PERMIT_INFO.permits.length >= 2)
  assert.ok(PERMIT_INFO.links.every((l) => l.href.startsWith('https://')))
})
