import { test } from 'node:test'
import assert from 'node:assert/strict'
import http2 from 'node:http2'
import crypto from 'node:crypto'

import { createApnsSender, loadApnsConfig } from '../src/apnsLiveActivity.mjs'
import { isoSeconds } from '../src/campusTime.mjs'
import {
  APPLE_EPOCH_SECONDS,
  LIFE_MINUTES,
  contentState,
  endLiveActivity,
  formatState,
  liveActivitiesEnabled,
  parseLiveActivityStart,
  parseState,
  planLiveActivity,
  runLiveActivities,
  serviceOver,
  startLiveActivity,
  updateLiveActivityToken,
} from '../src/liveActivities.mjs'
import { routeHours } from '../src/transitHours.mjs'
import { fakeSupabase, operation } from './routes/fakeSupabase.mjs'

// Issue #550, "Later": Track this bus, the Live Activity's server half. The
// stop's arrivals are readings in GET /api/transit/arrivals' shape, the
// database is an in-memory live_activities behind the shared recording fake,
// and APNs is a stub: a recording function, or in the last test a local
// HTTP/2 server behind the real sender. Nothing reaches TransLoc or Apple.

const NOW = Date.parse('2026-11-04T15:00:00Z') // Wednesday 10:00 AM on campus
const LATE = Date.parse('2026-11-05T03:30:00Z') // Wednesday 10:30 PM, Purple is done for the day
const S = NOW / 1000
const TOKEN = 'a1'.repeat(32)
const ACTIVITY = '6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5'

const ROUTES = {
  4: { routeId: 4, routeNum: '5', routeName: 'Purple', color: '#7A3E9D', hours: routeHours('5') },
  2: { routeId: 2, routeNum: '1', routeName: 'Crimson', color: '#990000', hours: routeHours('1') },
  30: { routeId: 30, routeNum: null, routeName: 'Charter', color: null, hours: null },
}
const PLACE = { key: 'riverwalk-apartments', name: 'Riverwalk Apartments', routes: [ROUTES[2], ROUTES[4]] }

// The stop's arrivals at `at`: [routeId, seconds away, vehicle] each.
function reading(buses, { at = NOW, place = PLACE } = {}) {
  return {
    place,
    fetchedAt: isoSeconds(at),
    arrivals: buses.map(([routeId, seconds, vehicleId = null]) => {
      const { routeNum, routeName, color } = ROUTES[routeId]
      return { routeId, routeNum, routeName, color, at: isoSeconds(at + seconds * 1000), source: 'transloc', vehicleId }
    }),
  }
}

function activity(extra = {}) {
  return {
    activity_id: ACTIVITY,
    push_token: TOKEN,
    apns_env: 'production',
    stop_key: 'riverwalk-apartments',
    route_id: 4,
    ends_at: new Date(NOW + LIFE_MINUTES * 60_000).toISOString(),
    ended_at: null,
    last_state: null,
    last_pushed_at: null,
    ...extra,
  }
}

// An activity that was last sent `state`, `ago` seconds before NOW.
const sent = (state, ago = 120, extra = {}) => activity({ last_state: formatState(state), last_pushed_at: new Date(NOW - ago * 1000).toISOString(), ...extra })

// ── Bodies and the stored state ─────────────────────────────────────────────

test('the start body: a UUID activity id, a hex token, the APNs host, a place key and an optional route', () => {
  const body = { activityId: ACTIVITY.toUpperCase(), token: TOKEN.toUpperCase(), env: 'development', stop: 'Riverwalk-Apartments', routeId: 4 }
  assert.deepEqual(parseLiveActivityStart(body), {
    ok: true,
    activity: { activityId: ACTIVITY, token: TOKEN, env: 'development', stop: 'riverwalk-apartments', routeId: 4 },
  })
  assert.equal(parseLiveActivityStart({ ...body, routeId: undefined }).activity.routeId, null)
  assert.equal(parseLiveActivityStart({ ...body, routeId: null }).activity.routeId, null)
  for (const bad of [
    { activityId: 'abc' },
    { activityId: undefined },
    { token: 'not hex' },
    { token: 'ab' },
    { env: 'sandbox' },
    { stop: 'Riverwalk Apartments' },
    { stop: '' },
    { routeId: '4' },
    { routeId: 0 },
    { routeId: 1.5 },
  ]) {
    const parsed = parseLiveActivityStart({ ...body, ...bad })
    assert.equal(parsed.ok, false, JSON.stringify(bad))
    assert.equal(typeof parsed.error, 'string')
  }
  assert.equal(parseLiveActivityStart(null).ok, false)
})

test('last_state is plain text the claim compares as read', () => {
  const state = { phase: 'due', at: S + 420, vehicle: 11, route: 4 }
  assert.equal(formatState(state), `due|${S + 420}|11|4`)
  assert.deepEqual(parseState(formatState(state)), state)
  assert.equal(formatState({ phase: 'arriving', at: S + 30 }), `arriving|${S + 30}|-|-`)
  assert.deepEqual(parseState(`arriving|${S + 30}|-|-`), { phase: 'arriving', at: S + 30, vehicle: null, route: null })
  assert.deepEqual(parseState('ended|student'), { phase: 'ended', reason: 'student' })
  for (const junk of [null, '', 'due', 'due|-|1|2', 'soon|1|2|3']) assert.equal(parseState(junk), null)
})

test('the content state carries the due time as Swift reads a Date: seconds since 2001-01-01', () => {
  const bus = { at: S + 420, routeNum: '5', routeName: 'Purple', color: '#7A3E9D' }
  const content = contentState('due', { bus })
  assert.deepEqual(content, { phase: 'due', arrivesAt: S + 420 - APPLE_EPOCH_SECONDS, routeNum: '5', routeName: 'Purple', color: '#7A3E9D' })
  assert.equal(new Date((content.arrivesAt + APPLE_EPOCH_SECONDS) * 1000).toISOString(), '2026-11-04T15:07:00.000Z')
  assert.equal(APPLE_EPOCH_SECONDS, Date.UTC(2001, 0, 1) / 1000)
  assert.deepEqual(contentState('expired'), { phase: 'expired', arrivesAt: null, routeNum: null, routeName: null, color: null })
})

test('Track this bus runs only with the APNs key, push on, and the kind not stopped', () => {
  const send = async () => ({ ok: true })
  assert.equal(liveActivitiesEnabled({ send, vapidKeys: {} }), true)
  assert.equal(liveActivitiesEnabled({ send: null, vapidKeys: {} }), false)
  assert.equal(liveActivitiesEnabled({ send, vapidKeys: null }), false)
  assert.equal(liveActivitiesEnabled({ send, vapidKeys: {}, kindsOff: new Set(['bus-live-activity']) }), false)
})

// ── The update rules ────────────────────────────────────────────────────────

test('the first reading after a start is pushed at priority 5, with the due time and a stale date 3 minutes ahead', () => {
  const plan = planLiveActivity(activity(), reading([[4, 420, 11], [2, 200, 21]]), NOW)
  assert.equal(plan.action, 'push')
  assert.equal(plan.priority, 5)
  assert.equal(plan.expiration, S + 60, 'an update is worth 60 seconds')
  assert.deepEqual(plan.state, { phase: 'due', at: S + 420, vehicle: 11, route: 4 })
  assert.deepEqual(plan.payload, {
    aps: {
      timestamp: S,
      event: 'update',
      'content-state': { phase: 'due', arrivesAt: S + 420 - APPLE_EPOCH_SECONDS, routeNum: '5', routeName: 'Purple', color: '#7A3E9D' },
      'stale-date': S + 180,
    },
  })
})

test('after that, an update goes only when the ETA moves by a minute or more', () => {
  const last = { phase: 'due', at: S + 420, vehicle: 11, route: 4 }
  for (const [seconds, pushed] of [
    [420, false],
    [479, false],
    [361, false],
    [480, true],
    [360, true],
    [900, true],
  ]) {
    const plan = planLiveActivity(sent(last), reading([[4, seconds, 11]]), NOW)
    assert.equal(plan.action, pushed ? 'push' : 'none', `due in ${seconds} s`)
    if (pushed) assert.equal(plan.payload.aps['content-state'].arrivesAt, S + seconds - APPLE_EPOCH_SECONDS)
  }
  // Time passing is no move: the phone counts down by itself.
  const later = NOW + 4 * 60_000
  assert.equal(planLiveActivity(sent(last, 360), reading([[4, 180, 11]], { at: later }), later).action, 'none')
})

test('and at most once a minute', () => {
  const last = { phase: 'due', at: S + 420, vehicle: 11, route: 4 }
  assert.equal(planLiveActivity(sent(last, 40), reading([[4, 600, 11]]), NOW).action, 'none')
  assert.equal(planLiveActivity(sent(last, 59), reading([[4, 600, 11]]), NOW).action, 'none')
  assert.equal(planLiveActivity(sent(last, 60), reading([[4, 600, 11]]), NOW).action, 'push')
})

test('Arriving, once the bus is due within a minute, goes at priority 10 with an alert, once', () => {
  const due = { phase: 'due', at: S + 90, vehicle: 11, route: 4 }
  const plan = planLiveActivity(sent(due, 30), reading([[4, 50, 11]]), NOW)
  assert.equal(plan.action, 'push')
  assert.equal(plan.priority, 10)
  assert.deepEqual(plan.state, { phase: 'arriving', at: S + 50, vehicle: 11, route: 4 })
  assert.deepEqual(plan.payload.aps.alert, { title: 'Route 5 Purple is arriving', body: 'At Riverwalk Apartments', sound: 'default' })
  assert.equal(plan.payload.aps['content-state'].phase, 'arriving')
  assert.equal(plan.payload.aps['stale-date'], S + 180)
  // Even right after another push, and on the first reading.
  assert.equal(planLiveActivity(sent(due, 5), reading([[4, 50, 11]]), NOW).priority, 10)
  assert.equal(planLiveActivity(activity(), reading([[4, 20, 11]]), NOW).state.phase, 'arriving')
  // Then nothing more while the bus is coming, even when its time moves.
  const arriving = { phase: 'arriving', at: S + 50, vehicle: 11, route: 4 }
  for (const seconds of [10, -30, 170]) {
    assert.equal(planLiveActivity(sent(arriving, 30), reading([[4, seconds, 11]]), NOW).action, 'none', `due in ${seconds} s`)
  }
  // An alert names as much of the route as there is.
  const charter = activity({ route_id: 30 })
  const place = { ...PLACE, routes: [...PLACE.routes, ROUTES[30]] }
  assert.equal(planLiveActivity(charter, reading([[30, 30, 5]], { place }), NOW).payload.aps.alert.title, 'Charter is arriving')
})

test('it follows one bus: the vehicle it showed, not a second bus that becomes sooner', () => {
  const last = { phase: 'due', at: S + 300, vehicle: 11, route: 4 }
  assert.equal(planLiveActivity(sent(last), reading([[4, 180, 12], [4, 330, 11]]), NOW).action, 'none')
  const moved = planLiveActivity(sent(last), reading([[4, 180, 12], [4, 420, 11]]), NOW)
  assert.deepEqual(moved.state, { phase: 'due', at: S + 420, vehicle: 11, route: 4 })
  // Its bus gone while still minutes away, the next bus takes its place,
  // on any route for an activity without one.
  const any = sent({ phase: 'due', at: S + 600, vehicle: 11, route: 4 }, 120, { route_id: null })
  const next = planLiveActivity(any, reading([[2, 610, 21]]), NOW)
  assert.deepEqual(next.state, { phase: 'due', at: S + 610, vehicle: 21, route: 2 })
  assert.equal(next.payload.aps['content-state'].routeName, 'Crimson')
})

test('without a current reading nothing is pushed', () => {
  assert.equal(planLiveActivity(activity(), null, NOW).action, 'none')
  assert.equal(planLiveActivity(sent({ phase: 'due', at: S + 400, vehicle: 11, route: 4 }), null, NOW).action, 'none')
})

// ── The end conditions ──────────────────────────────────────────────────────

test('it ends once the bus has come: after Arriving, the bus is gone or on its next trip around', () => {
  const arriving = { phase: 'arriving', at: S + 20, vehicle: 11, route: 4 }
  for (const buses of [[], [[4, 900, 12]], [[4, 1500, 11]]]) {
    const plan = planLiveActivity(sent(arriving, 30), reading(buses), NOW)
    assert.equal(plan.action, 'end', JSON.stringify(buses))
    assert.equal(plan.reason, 'arrived')
    assert.equal(plan.priority, 5)
    assert.equal(plan.expiration, S + 3600)
    assert.deepEqual(plan.state, { phase: 'ended', reason: 'arrived' })
    assert.deepEqual(plan.payload, {
      aps: {
        timestamp: S,
        event: 'end',
        'content-state': { phase: 'arrived', arrivesAt: null, routeNum: '5', routeName: 'Purple', color: '#7A3E9D' },
        'dismissal-date': S + 120,
      },
    })
  }
  // A bus due within two minutes that is gone came too, Arriving or not.
  const close = { phase: 'due', at: S + 90, vehicle: 11, route: 4 }
  assert.equal(planLiveActivity(sent(close, 30), reading([[4, 840, 12]]), NOW).reason, 'arrived')
})

test('it ends after its 30 minutes, with or without a reading', () => {
  const over = activity({ ends_at: new Date(NOW).toISOString(), last_state: formatState({ phase: 'due', at: S + 60, vehicle: 11, route: 4 }) })
  for (const current of [null, reading([[4, 60, 11]])]) {
    const plan = planLiveActivity(over, current, NOW)
    assert.equal(plan.action, 'end')
    assert.equal(plan.reason, 'expired')
    assert.equal(plan.payload.aps['content-state'].phase, 'expired')
  }
  assert.equal(planLiveActivity(activity({ ends_at: new Date(NOW + 1000).toISOString() }), null, NOW).action, 'none')
})

test('it ends at the end of service: no bus coming and the route past its hours', () => {
  assert.equal(serviceOver(PLACE, 4, LATE), true)
  assert.equal(serviceOver(PLACE, 4, NOW), false)
  // Saturday morning: Purple runs weekdays only.
  assert.equal(serviceOver(PLACE, 4, Date.parse('2026-11-07T15:00:00Z')), true)
  // Late on a weekday, the routes that run to midnight still run.
  assert.equal(serviceOver({ routes: [{ routeId: 9, hours: routeHours('3') }] }, 9, LATE), false)
  const late = planLiveActivity(activity({ ends_at: new Date(LATE + 600_000).toISOString() }), reading([], { at: LATE }), LATE)
  assert.equal(late.action, 'end')
  assert.equal(late.reason, 'no-service')
  // A last bus still coming after the hours keeps it going.
  assert.equal(planLiveActivity(activity({ ends_at: new Date(LATE + 600_000).toISOString() }), reading([[4, 300, 11]], { at: LATE }), LATE).action, 'push')
  // Within the hours, no bus for now is no end: the 30 minutes are.
  assert.equal(planLiveActivity(activity(), reading([[2, 300, 21]]), NOW).action, 'none')
  // Without a route, service is over only when every route at the stop is done.
  assert.equal(serviceOver(PLACE, null, LATE), true)
  assert.equal(serviceOver({ routes: [ROUTES[4], { routeId: 9, hours: routeHours('3') }] }, null, LATE), false)
  // A route whose hours are not on file never ends by service.
  assert.equal(serviceOver({ routes: [ROUTES[30]] }, 30, LATE), false)
  // A route that no longer stops there is done.
  assert.equal(serviceOver(PLACE, 77, NOW), true)
})

test('it ends when its stop is gone from TransLoc', () => {
  const plan = planLiveActivity(activity(), { gone: true }, NOW)
  assert.equal(plan.action, 'end')
  assert.equal(plan.reason, 'stop-gone')
})

// ── The tick ────────────────────────────────────────────────────────────────

// live_activities in memory, answering the chains the tick and the routes
// build: select with is / order / limit, insert (23505 on a known id), update
// with eq / is and .select().
function memoryDb(seed = [], { missing = false } = {}) {
  const rows = seed.map((row) => ({ ...row }))
  const answer = (chain) => {
    if (missing) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.live_activities' in the schema cache" } }
    const op = operation(chain)
    const matches = (row) =>
      chain.every(({ method, args: [column, value] }) => {
        if (method === 'eq') return row[column] === value
        if (method === 'is') return (row[column] ?? null) === value
        return true
      })
    if (op === 'insert') {
      const row = chain.find((call) => call.method === 'insert').args[0]
      if (rows.some((existing) => existing.activity_id === row.activity_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "live_activities_pkey"' } }
      }
      rows.push({ ended_at: null, last_state: null, last_pushed_at: null, ...row })
      return { data: { ends_at: row.ends_at }, error: null }
    }
    if (op === 'update') {
      const hit = rows.filter(matches)
      for (const row of hit) Object.assign(row, chain.find((call) => call.method === 'update').args[0])
      return { data: chain.some((call) => call.method === 'select') ? hit.map((row) => ({ ...row })) : null, error: null }
    }
    let out = rows.filter(matches)
    const limit = chain.find((call) => call.method === 'limit')
    if (limit) out = out.slice(0, limit.args[0])
    return { data: out.map((row) => ({ ...row })), error: null }
  }
  return { client: fakeSupabase({ live_activities: answer }), rows }
}

// APNs as a recording function: answer(push, n) gives the result.
function stubApns(answer = () => ({ ok: true, status: 200 })) {
  const pushes = []
  return {
    pushes,
    send: async (push) => {
      pushes.push(push)
      return answer(push, pushes.length)
    },
  }
}

const quiet = { warn: () => {}, log: () => {} }

test('a tick claims each push before it sends it, so two ticks at once send it once', async () => {
  const { client, rows } = memoryDb([activity()])
  const apns = stubApns()
  const readArrivals = async () => reading([[4, 420, 11]])
  const [a, b] = await Promise.all([
    runLiveActivities({ client, send: apns.send, readArrivals, now: new Date(NOW), log: quiet }),
    runLiveActivities({ client, send: apns.send, readArrivals, now: new Date(NOW), log: quiet }),
  ])
  assert.equal(apns.pushes.length, 1)
  assert.equal(a.updates + b.updates, 1)
  assert.equal(rows[0].last_state, `due|${S + 420}|11|4`)
  assert.equal(rows[0].last_pushed_at, new Date(NOW).toISOString())
  assert.deepEqual(apns.pushes[0], { token: TOKEN, env: 'production', payload: apns.pushes[0].payload, priority: 5, expiration: S + 60 })
  // The next tick, with nothing moved, sends nothing.
  const again = await runLiveActivities({ client, send: apns.send, readArrivals, now: new Date(NOW + 30_000), log: quiet })
  assert.deepEqual([again.open, again.updates, apns.pushes.length], [1, 0, 1])
})

test('it reads each stop once, however many activities follow it', async () => {
  const other = (id, stop) => activity({ activity_id: id, stop_key: stop })
  const { client } = memoryDb([activity(), other('7a1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5', 'riverwalk-apartments'), other('8a1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5', 'campus-center')])
  const reads = []
  const readArrivals = async (stop) => {
    reads.push(stop)
    return reading([[4, 420, 11]])
  }
  const apns = stubApns()
  const summary = await runLiveActivities({ client, send: apns.send, readArrivals, now: new Date(NOW), log: quiet })
  assert.deepEqual(reads.sort(), ['campus-center', 'riverwalk-apartments'])
  assert.equal(summary.open, 3)
  assert.equal(summary.updates, 3)
})

test('a reading older than a minute, or none at all, pushes nothing, but the 30 minutes still end an activity', async () => {
  const expired = activity({ activity_id: '9a1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5', ends_at: new Date(NOW - 1000).toISOString() })
  for (const readArrivals of [async () => reading([[4, 420, 11]], { at: NOW - 61_000 }), async () => Promise.reject(new Error('TransLoc is down'))]) {
    const { client, rows } = memoryDb([activity(), expired])
    const apns = stubApns()
    const summary = await runLiveActivities({ client, send: apns.send, readArrivals, now: new Date(NOW), log: quiet })
    assert.equal(apns.pushes.length, 1)
    assert.equal(apns.pushes[0].payload.aps.event, 'end')
    assert.deepEqual(summary.ended, { expired: 1 })
    assert.equal(rows[0].last_state, null)
    assert.equal(rows[1].ended_at, new Date(NOW).toISOString())
  }
})

test('every end condition reaches the phone as an end push and closes the row; the next tick reads none of them', async () => {
  // At 10:30 PM on a Wednesday, ten minutes into four activities' 30.
  const id = (n) => `${n}a1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5`
  const open = { ends_at: new Date(LATE + 20 * 60_000).toISOString() }
  const { client, rows } = memoryDb([
    activity({ activity_id: id(1), ends_at: new Date(LATE).toISOString() }),
    activity({ ...open, activity_id: id(2), last_state: formatState({ phase: 'arriving', at: LATE / 1000 + 10, vehicle: 11, route: 4 }) }),
    activity({ ...open, activity_id: id(3), stop_key: 'old-stop' }),
    activity({ ...open, activity_id: id(4), route_id: 2, stop_key: 'campus-center' }),
  ])
  const readings = {
    // Bus 11 came, and is on its next trip around.
    'riverwalk-apartments': reading([[4, 1500, 11]], { at: LATE }),
    // No place has the key any more.
    'old-stop': null,
    // Crimson ended at 10:00 PM, and no bus is coming.
    'campus-center': reading([], { at: LATE }),
  }
  const apns = stubApns()
  const now = new Date(LATE)
  const summary = await runLiveActivities({ client, send: apns.send, readArrivals: async (stop) => readings[stop], now, log: quiet })
  assert.deepEqual(summary.ended, { expired: 1, arrived: 1, 'stop-gone': 1, 'no-service': 1 })
  assert.deepEqual(apns.pushes.map((push) => [push.payload.aps.event, push.payload.aps['content-state'].phase]).sort(), [
    ['end', 'arrived'],
    ['end', 'expired'],
    ['end', 'no-service'],
    ['end', 'stop-gone'],
  ])
  assert.ok(rows.every((row) => row.ended_at === now.toISOString()))
  assert.deepEqual(rows.map((row) => row.last_state), ['ended|expired', 'ended|arrived', 'ended|stop-gone', 'ended|no-service'])
  const next = await runLiveActivities({ client, send: apns.send, readArrivals: async () => null, now, log: quiet })
  assert.equal(next.open, 0)
})

test('an APNs 410 ends the activity, and no tick sends to it again', async () => {
  const { client, rows } = memoryDb([activity()])
  const apns = stubApns(() => ({ ok: false, status: 410, reason: 'Unregistered', gone: true, retry: false }))
  const readArrivals = async () => reading([[4, 420, 11]])
  const summary = await runLiveActivities({ client, send: apns.send, readArrivals, now: new Date(NOW), log: quiet })
  assert.deepEqual(summary.ended, { gone: 1 })
  assert.deepEqual(summary.apns, { Unregistered: 1 })
  assert.equal(rows[0].ended_at, new Date(NOW).toISOString())
  assert.equal(rows[0].last_state, 'ended|gone')
  await runLiveActivities({ client, send: apns.send, readArrivals, now: new Date(NOW + 60_000), log: quiet })
  assert.equal(apns.pushes.length, 1)
})

test('the student ending it stops the pushes', async () => {
  const { client, rows } = memoryDb([activity()])
  assert.equal(await endLiveActivity(client, ACTIVITY, { now: new Date(NOW) }), true)
  assert.equal(await endLiveActivity(client, ACTIVITY, { now: new Date(NOW) }), false, 'already over')
  assert.equal(rows[0].last_state, 'ended|student')
  const apns = stubApns()
  const summary = await runLiveActivities({ client, send: apns.send, readArrivals: async () => reading([[4, 420, 11]]), now: new Date(NOW), log: quiet })
  assert.deepEqual([summary.open, apns.pushes.length], [0, 0])
})

test('with APNs down the claim goes back and the tick stops; the next tick sends it', async () => {
  const second = '7a1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5'
  const { client, rows } = memoryDb([activity(), activity({ activity_id: second })])
  const readArrivals = async () => reading([[4, 420, 11]])
  const down = stubApns(() => ({ ok: false, status: 503, reason: 'ServiceUnavailable', gone: false, retry: true }))
  const summary = await runLiveActivities({ client, send: down.send, readArrivals, now: new Date(NOW), log: quiet })
  assert.equal(summary.stopped, 'apns_unavailable')
  assert.ok(down.pushes.length >= 1 && down.pushes.length <= 2)
  assert.ok(rows.every((row) => row.last_state === null && row.last_pushed_at === null && row.ended_at === null))
  const up = stubApns()
  const next = await runLiveActivities({ client, send: up.send, readArrivals, now: new Date(NOW + 30_000), log: quiet })
  assert.equal(next.updates, 2)
  // An end too: it goes back to open and is sent on the next tick.
  const over = memoryDb([activity({ ends_at: new Date(NOW).toISOString() })])
  await runLiveActivities({ client: over.client, send: down.send, readArrivals, now: new Date(NOW), log: quiet })
  assert.equal(over.rows[0].ended_at, null)
  const ended = await runLiveActivities({ client: over.client, send: up.send, readArrivals, now: new Date(NOW + 30_000), log: quiet })
  assert.deepEqual(ended.ended, { expired: 1 })
})

test('APNs refusing the key stops the tick too; a push refused for good ends that activity', async () => {
  const readArrivals = async () => reading([[4, 420, 11]])
  const refused = memoryDb([activity()])
  const key = stubApns(() => ({ ok: false, status: 403, reason: 'InvalidProviderToken', gone: false, retry: false }))
  const summary = await runLiveActivities({ client: refused.client, send: key.send, readArrivals, now: new Date(NOW), log: quiet })
  assert.equal(summary.stopped, 'apns_refused')
  assert.equal(refused.rows[0].last_state, null)

  const bad = memoryDb([activity()])
  const once = stubApns(() => ({ ok: false, status: 400, reason: 'BadExpirationDate', gone: false, retry: false }))
  const ended = await runLiveActivities({ client: bad.client, send: once.send, readArrivals, now: new Date(NOW), log: quiet })
  assert.deepEqual(ended.ended, { refused: 1 })
  assert.equal(bad.rows[0].last_state, 'ended|refused')
})

test('before README step 58 the tick sends nothing and names the file once', async (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  const { client } = memoryDb([], { missing: true })
  const apns = stubApns()
  for (let i = 0; i < 2; i += 1) {
    const summary = await runLiveActivities({ client, send: apns.send, readArrivals: async () => null, now: new Date(NOW), log: quiet })
    assert.deepEqual([summary.ok, summary.reason], [false, 'not_configured'])
  }
  assert.equal(apns.pushes.length, 0)
  const lines = errors.mock.calls.map((call) => call.arguments.join(' ')).filter((line) => line.includes('db/supabase-live-activities.sql'))
  assert.equal(lines.length, 1)
})

// ── The routes' writes ──────────────────────────────────────────────────────

test('a start keeps its 30 minutes; sending it again replaces the token and keeps the end; an ended one stays ended', async () => {
  const { client, rows } = memoryDb()
  const start = { activityId: ACTIVITY, token: TOKEN, env: 'production', stop: 'riverwalk-apartments', routeId: 4 }
  const endsAt = new Date(NOW + 30 * 60_000).toISOString()
  assert.deepEqual(await startLiveActivity(client, start, { userId: 'u1', now: new Date(NOW) }), { status: 'started', endsAt })
  assert.deepEqual(rows[0], {
    activity_id: ACTIVITY,
    user_id: 'u1',
    push_token: TOKEN,
    apns_env: 'production',
    stop_key: 'riverwalk-apartments',
    route_id: 4,
    ends_at: endsAt,
    ended_at: null,
    last_state: null,
    last_pushed_at: null,
  })
  const again = await startLiveActivity(client, { ...start, token: 'b2'.repeat(32) }, { now: new Date(NOW + 5 * 60_000) })
  assert.deepEqual(again, { status: 'refreshed', endsAt })
  assert.equal(rows[0].push_token, 'b2'.repeat(32))
  assert.equal(rows[0].user_id, 'u1')
  assert.deepEqual(await updateLiveActivityToken(client, ACTIVITY, 'c3'.repeat(32)), { endsAt })
  assert.equal(rows[0].push_token, 'c3'.repeat(32))
  await endLiveActivity(client, ACTIVITY, { now: new Date(NOW) })
  assert.deepEqual(await startLiveActivity(client, start, { now: new Date(NOW) }), { status: 'ended' })
  assert.equal(await updateLiveActivityToken(client, ACTIVITY, TOKEN), null)
})

// ── Through the real sender ─────────────────────────────────────────────────

test('a tick reaches a stubbed APNs through the real sender: one session, the liveactivity headers, the content state', async () => {
  const requests = []
  const server = http2.createServer()
  const open = new Set()
  server.on('session', (session) => open.add(session))
  server.on('stream', (stream, headers) => {
    const chunks = []
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => {
      requests.push({ headers, body: JSON.parse(chunks.join('')) })
      stream.respond({ ':status': 200 })
      stream.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  const sender = createApnsSender({
    config: loadApnsConfig({ APNS_KEY_P8: key, APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456' }),
    origins: { production: origin, development: origin },
  })
  try {
    // One activity just started at Riverwalk, one on the development host
    // whose bus is a minute from Campus Center.
    const { client } = memoryDb([
      activity(),
      sent({ phase: 'due', at: S + 90, vehicle: 12, route: 4 }, 30, { activity_id: '7a1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5', apns_env: 'development', stop_key: 'campus-center' }),
    ])
    const readings = { 'riverwalk-apartments': reading([[4, 420, 11]]), 'campus-center': reading([[4, 45, 12]]) }
    const summary = await runLiveActivities({ client, send: sender.send, readArrivals: async (stop) => readings[stop], now: new Date(NOW), log: quiet })
    assert.deepEqual([summary.updates, summary.arriving, summary.failed], [1, 1, 0])
    assert.equal(open.size, 1, 'one HTTP/2 session for both')
    const byPriority = Object.fromEntries(requests.map((request) => [request.headers['apns-priority'], request]))
    assert.equal(byPriority['5'].headers[':path'], `/3/device/${TOKEN}`)
    assert.equal(byPriority['5'].headers['apns-push-type'], 'liveactivity')
    assert.equal(byPriority['5'].headers['apns-expiration'], String(S + 60))
    assert.equal(byPriority['5'].body.aps['content-state'].phase, 'due')
    assert.equal(byPriority['10'].body.aps['content-state'].phase, 'arriving')
    assert.equal(byPriority['10'].body.aps.alert.title, 'Route 5 Purple is arriving')
  } finally {
    sender.close()
    for (const session of open) session.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})
