import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DINING_FAVORITES_CAP_MESSAGE,
  DRAFT_CAMPAIGNS_CAP_MESSAGE,
  GRADES_CAP_MESSAGE,
  MANUAL_TASKS_CAP_MESSAGE,
  MAX_DINING_FAVORITES,
  MAX_DRAFT_CAMPAIGNS,
  MAX_GRADES,
  MAX_MANUAL_TASKS,
  advertiserWriteBucketKey,
  exceedsCap,
} from '../src/userWriteCaps.mjs'
import { bucketKey, createRateLimiter } from '../src/rateLimiter.mjs'

// Issue #202: row caps on the create routes and the advertiser-write bucket key.

test('the caps match the values agreed on the issue', () => {
  assert.equal(MAX_MANUAL_TASKS, 500)
  assert.equal(MAX_GRADES, 500)
  assert.equal(MAX_DINING_FAVORITES, 300)
  assert.equal(MAX_DRAFT_CAMPAIGNS, 20)
})

test('each cap message names its limit', () => {
  assert.match(MANUAL_TASKS_CAP_MESSAGE, /\b500 tasks\b/)
  assert.match(GRADES_CAP_MESSAGE, /\b500 courses\b/)
  assert.match(DINING_FAVORITES_CAP_MESSAGE, /\b300 favorites\b/)
  assert.match(DRAFT_CAMPAIGNS_CAP_MESSAGE, /\b20 draft campaigns\b/)
})

test('exceedsCap allows an insert until the caller already owns cap rows', () => {
  assert.equal(exceedsCap(0, 500), false)
  assert.equal(exceedsCap(498, 500), false)
  assert.equal(exceedsCap(499, 500), false, 'the 500th row is still allowed')
  assert.equal(exceedsCap(500, 500), true, 'a 501st row is not')
  assert.equal(exceedsCap(750, 500), true, 'rows over the cap from a race still block')
})

test('exceedsCap fails open when the count is missing or not a number', () => {
  for (const count of [null, undefined, NaN, Infinity, '600', {}]) {
    assert.equal(exceedsCap(count, 20), false, `count ${String(count)}`)
  }
})

test('advertiserWriteBucketKey keys a portal session by the advertiser id', () => {
  assert.equal(advertiserWriteBucketKey({ session: { advertiserId: 'a1b2' } }), 'adv:a1b2')
})

test('advertiserWriteBucketKey returns null without an advertiser session', () => {
  assert.equal(advertiserWriteBucketKey({}), null)
  assert.equal(advertiserWriteBucketKey({ session: undefined }), null)
  assert.equal(advertiserWriteBucketKey({ session: {} }), null)
  assert.equal(advertiserWriteBucketKey({ session: { advertiserId: '' } }), null)
  assert.equal(advertiserWriteBucketKey({ session: { advertiserId: 42 } }), null)
  // A student session is not an advertiser session.
  assert.equal(advertiserWriteBucketKey({ session: { userId: 'u1' } }), null)
  assert.equal(advertiserWriteBucketKey(undefined), null)
})

test('the advertiser-write key lands in its own bucket, and anonymous callers in the IP bucket', () => {
  assert.equal(bucketKey({ ip: '10.0.0.5', session: { advertiserId: 'a1' } }, advertiserWriteBucketKey), 'k:adv:a1')
  assert.equal(bucketKey({ ip: '10.0.0.5', session: {} }, advertiserWriteBucketKey), 'ip:10.0.0.5')
})

test('two advertisers behind one IP do not share an advertiser-write budget', () => {
  const limiter = createRateLimiter({ name: 'test-advertiser-write', windowMs: 60_000, max: 1, keyBy: advertiserWriteBucketKey })
  const run = (session) => {
    let allowed = false
    const res = { setHeader() {}, status() { return this }, json() { return this } }
    limiter({ ip: '10.0.0.6', method: 'POST', path: '/api/advertiser/campaigns', session }, res, () => {
      allowed = true
    })
    return allowed
  }
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(run({ advertiserId: 'a1' }), true)
    assert.equal(run({ advertiserId: 'a1' }), false, 'a1 is out of budget')
    assert.equal(run({ advertiserId: 'a2' }), true, 'a2 has its own budget behind the same IP')
    assert.equal(run({}), true, 'a signed-out caller on that IP uses the IP bucket')
  } finally {
    console.warn = warn
  }
})
