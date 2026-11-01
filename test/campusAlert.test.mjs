// Campus emergency alerts (issue #34): IU's public alert feed for its
// Indianapolis campus, read for the banner on the website and the app. The
// fixture is the feed's real answer of 2026-11-01, IU's all clear of
// 2026-09-12. The feed holds only its latest message, so the active alerts
// below are built from IU's public history page (emergency.iu.edu/rave),
// which lists each message's description: the descriptions are IU's words,
// the headlines stand in for ones the history does not show.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  CAMPUS_ALERTS_OFF,
  IU_ALERT_FEED_URL,
  MAX_HEADLINE_CHARS,
  MAX_MESSAGE_CHARS,
  STALE_AFTER_MS,
  alertLevel,
  campusAlertAnswer,
  fetchCampusAlert,
  readIuAlert,
} from '../src/campusAlert.mjs'

const NORMAL = JSON.parse(readFileSync(new URL('./fixtures/iu-alert-indianapolis.json', import.meta.url), 'utf8'))

/** A CAP message shaped like IU's, with the fields a test names replaced. */
function capMessage({ identifier = '17892038570001397900001', sent = '2026-09-12T03:49:00-04:00', status = 'Actual', ...info } = {}) {
  return { ...NORMAL, identifier, sent, status, info: { ...NORMAL.info, ...info } }
}

const DANGEROUS_SITUATION = capMessage({
  severity: 'Severe',
  headline: 'IU Indy emergency: Dangerous situation near Sports Complex Garage',
  description:
    'IU Indianapolis emergency: A dangerous situation is occurring on campus near Sports Complex Garage and Riverwalk Garage. Avoid the area and trust your instincts. Call 911 with information. For available information and updates on this dangerous situation visit emergency.iu.edu.',
})
const TORNADO_TEST = capMessage({
  identifier: '17892038570001397900002',
  sent: '2026-03-10T10:15:00-04:00',
  severity: 'Extreme',
  headline: 'IU Indy TEST Alert: NWS TEST Tornado Warning',
  description:
    'IU Indy TEST Alert: Marion Co: NWS TEST Tornado Warning issued March 10 at 10:15 AM EDT expiring March 10 at 10:30 AM EDT. Seek shelter by proceeding to a designated severe weather shelter location in your immediate vicinity. THIS IS ONLY A DRILL.',
})
const LIMITED_OPERATIONS = capMessage({
  identifier: '17892038570001397900003',
  sent: '2026-01-25T18:43:00-05:00',
  severity: 'Moderate',
  headline: 'IU Indy alert: Limited operations Jan. 26',
  description: 'IU Indy alert: The IU Indianapolis campus will be in a state of limited operations on Jan. 26 due to severe winter weather. Normal operations resume Jan. 27, 6am.',
})

test('the real feed answer reads as IU\'s all clear, which is not an active alert', () => {
  assert.deepEqual(readIuAlert(NORMAL), {
    id: '17892038570001397942073',
    sentAt: '2026-09-12T09:04:17.000Z',
    headline: 'IU Indy Alert: Campus Status Normal',
    message: 'IU Indianapolis Alert: Campus Status Normal',
    instruction: null,
    severity: 'Unknown',
    test: false,
    normal: true,
  })
  const answer = campusAlertAnswer({ fetchedAt: Date.parse('2026-11-01T10:42:15.000Z'), alert: readIuAlert(NORMAL) }, { now: Date.parse('2026-11-01T10:42:20.000Z') })
  assert.deepEqual(answer, { enabled: true, active: false, alert: null, checkedAt: '2026-11-01T10:42:15.000Z', stale: false })
})

test('any message but the all clear is an active alert, credited to IU and shown in IU\'s words', () => {
  const fetchedAt = Date.parse('2026-09-12T07:49:30.000Z')
  const answer = campusAlertAnswer({ fetchedAt, alert: readIuAlert(DANGEROUS_SITUATION) }, { now: fetchedAt + 1000 })
  assert.deepEqual(answer, {
    enabled: true,
    active: true,
    alert: {
      id: '17892038570001397900001',
      source: 'IU Indianapolis',
      sentAt: '2026-09-12T07:49:00.000Z',
      headline: 'IU Indy emergency: Dangerous situation near Sports Complex Garage',
      message: DANGEROUS_SITUATION.info.description,
      instruction: null,
      severity: 'Severe',
      level: 'danger',
      test: false,
    },
    checkedAt: '2026-09-12T07:49:30.000Z',
    stale: false,
  })
})

test('IU\'s "final alert" is still an alert: only Campus Status Normal clears the banner, whatever `expires` says', () => {
  const final = readIuAlert(capMessage({ headline: 'IU Indy final alert: There is no longer a threat near the Sports Complex Garage.', description: '' }))
  assert.equal(final.normal, false)
  // IU sets expires 15 minutes after sent; long past it, the alert stays up.
  const answer = campusAlertAnswer({ fetchedAt: Date.parse('2026-09-12T10:00:00.000Z'), alert: final }, { now: Date.parse('2026-09-12T10:00:05.000Z') })
  assert.equal(answer.active, true)
  // Matched without regard to case, as IU spells it "Campus Status Normal" in both fields today.
  assert.equal(readIuAlert(capMessage({ headline: 'IU INDY ALERT: CAMPUS STATUS NORMAL' })).normal, true)
})

test('tests and drills are marked as tests, and severity sets how loudly the rest are shown', () => {
  const drill = readIuAlert(TORNADO_TEST)
  assert.equal(drill.test, true)
  assert.equal(alertLevel(drill), 'test')
  assert.equal(readIuAlert(capMessage({ headline: 'IUPUI Drill: This is only a drill.' })).test, true)
  assert.equal(readIuAlert(capMessage({ status: 'Exercise', headline: 'Shelter in place' })).test, true)
  // A lowercase "test" is ordinary text, not a drill.
  assert.equal(readIuAlert(capMessage({ headline: 'Avoid the testing center lot', description: 'Police activity near the test center.' })).test, false)

  assert.equal(alertLevel(readIuAlert(LIMITED_OPERATIONS)), 'warning')
  assert.equal(alertLevel(readIuAlert(capMessage({ severity: 'Minor', headline: 'IU Indy alert: Power outage' }))), 'warning')
  assert.equal(alertLevel(readIuAlert(DANGEROUS_SITUATION)), 'danger')
  // An unknown or missing severity is shown as an emergency, never played down.
  assert.equal(readIuAlert(capMessage({ severity: 'Catastrophic', headline: 'IU Indy emergency' })).severity, 'Unknown')
  assert.equal(alertLevel(readIuAlert(capMessage({ severity: undefined, headline: 'IU Indy emergency' }))), 'danger')
})

test('the text is IU\'s, with whitespace collapsed, control characters dropped and a length cap', () => {
  const alert = readIuAlert(
    capMessage({
      headline: '  IU Indy alert:\n\tShots fired\u0007 near 10th and Indiana Ave.  ',
      description: 'x'.repeat(MAX_MESSAGE_CHARS + 50),
      instruction: ' Avoid the area. ',
    }),
  )
  assert.equal(alert.headline, 'IU Indy alert: Shots fired near 10th and Indiana Ave.')
  assert.equal(alert.message.length, MAX_MESSAGE_CHARS)
  assert.ok(alert.message.endsWith('…'))
  assert.equal(alert.instruction, 'Avoid the area.')
  assert.equal(readIuAlert(capMessage({ headline: 'y'.repeat(MAX_HEADLINE_CHARS * 2) })).headline.length, MAX_HEADLINE_CHARS)
  // A description that only repeats the headline is not shown twice.
  assert.equal(readIuAlert(capMessage({ headline: 'IU Indy alert: Power outage.', description: 'iu indy alert power outage' })).message, null)
})

test('a payload that is not a readable CAP message reads as null', () => {
  for (const payload of [null, undefined, 'IU', [], {}, { info: null }, { info: {} }, { info: { headline: '   ' } }, { info: [] }]) {
    assert.equal(readIuAlert(payload), null, JSON.stringify(payload))
  }
  // CAP allows several info blocks; the first is the one IU writes.
  assert.equal(readIuAlert({ ...NORMAL, info: [NORMAL.info, { headline: 'Second' }] }).headline, 'IU Indy Alert: Campus Status Normal')
  // An unreadable time is null rather than a made-up one.
  assert.equal(readIuAlert({ ...NORMAL, sent: 'soon' }).sentAt, null)
})

test('a reading the cache kept serving past STALE_AFTER_MS is marked stale', () => {
  const fetchedAt = Date.parse('2026-09-12T07:49:30.000Z')
  const reading = { fetchedAt, alert: readIuAlert(DANGEROUS_SITUATION) }
  assert.equal(campusAlertAnswer(reading, { now: fetchedAt + STALE_AFTER_MS }).stale, false)
  assert.equal(campusAlertAnswer(reading, { now: fetchedAt + STALE_AFTER_MS + 1 }).stale, true)
  assert.equal(campusAlertAnswer(reading, { now: fetchedAt + STALE_AFTER_MS + 1 }).active, true)
})

test('with the switch off the answer says so and carries nothing', () => {
  assert.deepEqual(CAMPUS_ALERTS_OFF, { enabled: false, active: false, alert: null, checkedAt: null, stale: false })
  assert.ok(Object.isFrozen(CAMPUS_ALERTS_OFF))
})

test('fetchCampusAlert asks IU\'s Indianapolis feed for JSON and reads the answer', async () => {
  const calls = []
  const reading = await fetchCampusAlert({
    now: () => 1_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(NORMAL), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.deepEqual(reading, { fetchedAt: 1_000, alert: readIuAlert(NORMAL) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, IU_ALERT_FEED_URL)
  assert.match(IU_ALERT_FEED_URL, /\/rave\/indianapolis\?output=json$/)
  assert.equal(calls[0].init.headers.Accept, 'application/json')
  assert.match(calls[0].init.headers['User-Agent'], /BoilerIndy/)
  assert.ok(calls[0].init.signal instanceof AbortSignal)
})

test('fetchCampusAlert throws on a failed answer or an unreadable message, so the cache keeps the last good one', async () => {
  await assert.rejects(
    fetchCampusAlert({ fetchImpl: async () => new Response('busy', { status: 503 }) }),
    /answered 503/,
  )
  await assert.rejects(
    fetchCampusAlert({ fetchImpl: async () => new Response(JSON.stringify({ info: {} }), { status: 200 }) }),
    /without a headline/,
  )
  await assert.rejects(
    fetchCampusAlert({ fetchImpl: async () => { throw new TypeError('fetch failed') } }),
    /fetch failed/,
  )
})
