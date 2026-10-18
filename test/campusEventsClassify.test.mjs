import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVENT_QUESTIONS,
  JEV_MODEL,
  QUESTIONS_VERSION,
  THRESHOLDS,
  applyVerdict,
  classifyCampusEvents,
  classifyModeFromSetting,
  createCampusEventsClassifier,
  eventState,
  verdictFrom,
  verdictIsCurrent,
} from '../src/campusEventsClassify.mjs'
import { JEV_API_URL, JevError } from '../src/jevClient.mjs'
import { CATEGORIES, VENUE_KINDS } from '../src/sharedEvents.mjs'
import { fakeSupabase, hasCall, operation } from './routes/fakeSupabase.mjs'

// Issue #30: Jev at ingest. Jev itself is faked (src/jevClient.mjs has its own
// wire tests), and so is the stored verdict read. The rows are trimmed
// campus_events rows, the answers shaped as Jev sends them.

const NOW = new Date('2026-10-18T12:00:00.000Z')
const quiet = { log() {}, warn() {}, error() {} }

function row(dedupeKey, fields = {}) {
  return {
    title: `Event ${dedupeKey}`,
    description: null,
    starts_at: '2026-10-22T22:00:00.000Z',
    ends_at: null,
    location: 'Campus Center 450',
    all_day: false,
    source_key: 'iu_events',
    source_url: null,
    external_uid: dedupeKey,
    dedupe_key: dedupeKey,
    category: null,
    free_food: false,
    venue_kind: 'indy_campus',
    open_to_all: null,
    series_key: `iu_events:${dedupeKey}`,
    content_hash: `hash-${dedupeKey}`,
    ...fields,
  }
}

/** Jev's answers, as the API sends them; `over` replaces some. */
function answers({ food = 0.05, open = 0.6, category = ['social', 0.5], where = ['indy_campus', 0.95] } = {}) {
  const choice = ([key, p], options) => ({
    type: 'choice',
    choice: key,
    probabilities: Object.fromEntries(options.map((option) => [option, option === key ? p : (1 - p) / (options.length - 1)])),
    confidence: p,
  })
  return {
    free_food: { type: 'noul', noul: food },
    open_to_all: { type: 'noul', noul: open },
    category: choice(category, Object.keys(EVENT_QUESTIONS.category.criteria)),
    where: choice(where, Object.keys(EVENT_QUESTIONS.where.criteria)),
  }
}

const verdict = (over = {}) => verdictFrom({ model: JEV_MODEL, answers: answers(over) }, NOW)

/** A fake Jev: `answer(state)` gives the answers or throws; every state asked is recorded. */
function fakeJev(answer = () => answers()) {
  const asked = []
  return {
    asked,
    model: JEV_MODEL,
    evaluate: async (state) => {
      asked.push(state.title)
      return { model: JEV_MODEL, answers: answer(state), usage: { input_tokens: 1200 } }
    },
  }
}

/** campus_events holding `stored` verdicts; the read answers those whose key it asked for. */
function database(stored = [], { fail } = {}) {
  return fakeSupabase({
    campus_events: (chain) => {
      assert.equal(operation(chain), 'select')
      if (fail) return fail(chain)
      const keys = chain.find((call) => call.method === 'in')?.args[1] ?? []
      return { data: stored.filter((entry) => keys.includes(entry.dedupe_key)), error: null }
    },
  })
}

test('CAMPUS_EVENTS_CLASSIFY reads as on, shadow or off', () => {
  for (const value of ['on', 'ON', ' 1 ', 'true']) assert.equal(classifyModeFromSetting(value), 'on')
  assert.equal(classifyModeFromSetting('shadow'), 'shadow')
  for (const value of ['off', '', undefined, null, 'yes', 'boilerlink']) assert.equal(classifyModeFromSetting(value), 'off')
})

test('the questions answer in the columns CHECK values, on a pinned model', () => {
  const categories = Object.keys(EVENT_QUESTIONS.category.criteria)
  assert.deepEqual([...categories].sort(), CATEGORIES.filter((key) => key !== 'deadline').sort())
  assert.deepEqual(Object.keys(EVENT_QUESTIONS.where.criteria).sort(), [...VENUE_KINDS].sort())
  for (const key of ['free_food', 'open_to_all']) {
    assert.equal(EVENT_QUESTIONS[key].type, 'noul')
    assert.deepEqual(Object.keys(EVENT_QUESTIONS[key].criteria), ['true', 'false'])
  }
  assert.match(JEV_MODEL, /^jev-\d+\.\d+\.\d+$/, 'a versioned id, never jev-latest')
  assert.match(QUESTIONS_VERSION, /^[0-9a-f]{12}$/)
  assert.ok(THRESHOLDS.categoryOverride > THRESHOLDS.categoryFill)
  assert.ok(THRESHOLDS.closed < THRESHOLDS.open)
})

test('Jev reads the listing as named fields: title, place, start in campus time, description cut at 1500', () => {
  const state = eventState(row('a', {
    title: 'Honors House Coffee',
    description: 'Enjoy some free Caribou Coffee.',
    location: 'ET Atrium',
    starts_at: '2026-10-29T22:00:00.000Z',
  }))
  assert.deepEqual(Object.keys(state), ['title', 'location', 'starts', 'description'])
  assert.equal(state.starts.replace(/\s/g, ' '), 'Thu, Oct 29, 6:00 PM (Indianapolis time)')
  assert.equal(state.description, 'Enjoy some free Caribou Coffee.')

  const allDay = eventState(row('b', { location: null, starts_at: '2026-10-18T04:00:00.000Z', all_day: true }))
  assert.deepEqual(allDay, { title: 'Event b', starts: 'Sun, Oct 18 (all day)' })

  const long = eventState(row('c', { description: 'x'.repeat(4000) }))
  assert.equal(long.description.length, 1503)
  assert.ok(long.description.endsWith('...'))
  // Nothing but the listing: no keys, links or ids reach TypeSafe.
  assert.ok(!JSON.stringify(eventState(row('d'))).includes('hash-d'))
})

test('a verdict keeps every answer with its probabilities, the model and the question version', () => {
  const stored = verdict({ category: ['wellness', 0.93] })
  assert.equal(stored.model, JEV_MODEL)
  assert.equal(stored.questions, QUESTIONS_VERSION)
  assert.equal(stored.classified_at, NOW.toISOString())
  assert.deepEqual(stored.answers.free_food, { p: 0.05 })
  assert.equal(stored.answers.category.choice, 'wellness')
  assert.equal(stored.answers.category.p, 0.93)
  assert.equal(Object.keys(stored.answers.category.probabilities).length, 10)
  assert.equal(stored.answers.where.choice, 'indy_campus')
  assert.ok(verdictIsCurrent(stored))

  // A missing or malformed answer is no verdict at all.
  const partial = answers()
  delete partial.where
  assert.equal(verdictFrom({ model: JEV_MODEL, answers: partial }, NOW), null)
  assert.equal(verdictFrom({ model: JEV_MODEL, answers: { ...answers(), free_food: { type: 'noul', noul: 1.4 } } }, NOW), null)
  const offList = answers()
  offList.category = { ...offList.category, choice: 'deadline' }
  assert.equal(verdictFrom({ model: JEV_MODEL, answers: offList }, NOW), null)

  assert.equal(verdictIsCurrent({ ...stored, model: 'jev-1.14.0' }), false)
  assert.equal(verdictIsCurrent({ ...stored, questions: 'abcdefabcdef' }), false)
  assert.equal(verdictIsCurrent(null), false)
})

test('free food: the source word always stands, Jev replaces the keyword matcher at 0.7', () => {
  const food = (p, fields, sourceFreeFood = false) => applyVerdict(row('f', fields), verdict({ food: p }), { sourceFreeFood }).free_food
  assert.equal(food(0.05, { free_food: true }, true), true) // a "Free food" tag Jev cannot read
  assert.equal(food(0.2, { free_food: true }), false) // the matcher's word alone, Jev says no
  assert.equal(food(THRESHOLDS.freeFood, { free_food: false }), true) // "enjoy some free Caribou Coffee"
  assert.equal(food(0.69, { free_food: false }), false)
})

test('open to all: a members-only rule stays, Jev closes under 0.2 and opens at 0.8, a deadline is left alone', () => {
  const open = (p, fields) => applyVerdict(row('o', fields), verdict({ open: p })).open_to_all
  assert.equal(open(0.95, { open_to_all: false }), false) // "Taekwondo Practices"
  assert.equal(open(0.1, { open_to_all: true }), false) // instructors' monthly meeting
  assert.equal(open(0.85, { open_to_all: null }), true)
  assert.equal(open(0.5, { open_to_all: true }), true)
  assert.equal(open(0.5, { open_to_all: null }), null)
  assert.equal(open(0.05, { open_to_all: true, category: 'deadline' }), true) // "University offices closed"
})

test('category: Jev fills an empty one at 0.7, replaces the source at 0.9, never a deadline', () => {
  const category = (pick, p, fields) => applyVerdict(row('c', fields), verdict({ category: [pick, p] })).category
  assert.equal(category('career', 0.75, { category: null }), 'career')
  assert.equal(category('career', 0.65, { category: null }), null)
  assert.equal(category('wellness', 0.95, { category: 'academic' }), 'wellness') // "1:1 Workshops: Mental Well-being"
  assert.equal(category('wellness', 0.85, { category: 'academic' }), 'academic')
  assert.equal(category('other', 1, { category: 'deadline' }), 'deadline')
})

test('venue: only an unknown one, and only to online or elsewhere at 0.9', () => {
  const venue = (pick, p, kind) => applyVerdict(row('v', { venue_kind: kind }), verdict({ where: [pick, p] })).venue_kind
  assert.equal(venue('online', 0.95, 'unknown'), 'online')
  assert.equal(venue('elsewhere', THRESHOLDS.venue, 'unknown'), 'elsewhere') // an away tournament
  assert.equal(venue('online', 0.85, 'unknown'), 'unknown')
  assert.equal(venue('indy_campus', 0.99, 'unknown'), 'unknown') // Jev cannot tell the two campuses apart
  assert.equal(venue('west_lafayette', 0.99, 'unknown'), 'unknown')
  assert.equal(venue('elsewhere', 0.99, 'indy_campus'), 'indy_campus')
})

test('applyVerdict returns a new row and leaves the planned one alone', () => {
  const planned = row('p', { free_food: false })
  const out = applyVerdict(planned, verdict({ food: 0.9 }))
  assert.equal(out.free_food, true)
  assert.equal(planned.free_food, false)
  assert.equal(applyVerdict(planned, null), planned)
})

test('only rows with no current verdict for their text are asked; the rest reuse the stored one', async () => {
  const rows = [
    row('kept', { category: 'academic' }), // stored, same text, current
    row('edited'), // stored, but the text changed since
    row('old-model'), // stored by another model
    row('new'), // never asked
  ]
  const stored = [
    { dedupe_key: 'kept', content_hash: 'hash-kept', classifier: verdict({ category: ['wellness', 0.97], food: 0.9 }) },
    { dedupe_key: 'edited', content_hash: 'hash-before', classifier: verdict() },
    { dedupe_key: 'old-model', content_hash: 'hash-old-model', classifier: { ...verdict(), model: 'jev-1.12.0' } },
  ]
  const client = database(stored)
  const jev = fakeJev()
  const { rows: out, summary } = await classifyCampusEvents(rows, { client, jev, now: () => NOW, log: quiet })

  assert.deepEqual(jev.asked, ['Event edited', 'Event old-model', 'Event new'])
  const [read] = client.queriesOf('campus_events')
  assert.ok(hasCall(read.chain, 'select', 'dedupe_key, content_hash, classifier'))
  assert.ok(hasCall(read.chain, 'in', 'dedupe_key', ['kept', 'edited', 'old-model', 'new']))
  assert.ok(hasCall(read.chain, 'not', 'classifier', 'is', null))

  const kept = out.find((r) => r.dedupe_key === 'kept')
  assert.equal(kept.classifier, stored[0].classifier) // written back as it was
  assert.equal(kept.category, 'wellness')
  assert.equal(kept.free_food, true)
  for (const r of out) assert.ok(verdictIsCurrent(r.classifier), r.dedupe_key)
  assert.equal(summary.mode, 'on')
  assert.equal(summary.model, JEV_MODEL)
  assert.equal(summary.reused, 1)
  assert.equal(summary.asked, 3)
  assert.equal(summary.answered, 3)
  assert.equal(summary.failed, 0)
  assert.equal(summary.deferred, 0)
  assert.equal(summary.stopped, null)
  assert.equal(summary.inputTokens, 3600)
  // Only the reused verdict changes anything: the fake's `social` at 0.5 is under the fill bar.
  assert.deepEqual(summary.changed, { free_food: 1, open_to_all: 0, category: 1, venue_kind: 0 })
})

test('the stored verdicts are read 100 keys at a time', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => row(`k${i}`))
  const client = database()
  await classifyCampusEvents(rows, { client, jev: fakeJev(), log: quiet })
  const reads = client.queriesOf('campus_events').map((q) => q.chain.find((call) => call.method === 'in').args[1].length)
  assert.deepEqual(reads, [100, 100, 50])
})

test('shadow stores the verdicts and changes nothing, and says what it would change', async () => {
  const rows = [row('coffee', { title: 'Honors House Coffee' }), row('meeting', { title: 'BIOL K101 Instructor Monthly Meetings', open_to_all: true })]
  const jev = fakeJev((state) => (state.title.includes('Coffee') ? answers({ food: 0.99 }) : answers({ open: 0.1 })))
  const { rows: out, summary } = await classifyCampusEvents(rows, { client: database(), jev, mode: 'shadow', log: quiet })
  assert.equal(out[0].free_food, false)
  assert.equal(out[1].open_to_all, true)
  assert.ok(out.every((r) => verdictIsCurrent(r.classifier)))
  assert.equal(summary.mode, 'shadow')
  assert.equal(summary.changed.free_food, 1)
  assert.equal(summary.changed.open_to_all, 1)
  assert.deepEqual(summary.examples.filter((e) => e.column !== 'category'), [
    { dedupe_key: 'coffee', title: 'Honors House Coffee', column: 'free_food', from: false, to: true },
    { dedupe_key: 'meeting', title: 'BIOL K101 Instructor Monthly Meetings', column: 'open_to_all', from: true, to: false },
  ])
})

test('a failed call leaves its row to the rules for the next run; the run goes on', async () => {
  const warnings = []
  const log = { ...quiet, warn: (line) => warnings.push(line) }
  const rows = [row('a'), row('b', { free_food: true }), row('c')]
  const jev = fakeJev((state) => {
    if (state.title === 'Event b') throw new JevError('Jev responded 529', { status: 529 })
    return answers({ food: 0.9 })
  })
  const { rows: out, summary } = await classifyCampusEvents(rows, { client: database(), jev, log })
  const b = out.find((r) => r.dedupe_key === 'b')
  assert.ok(!('classifier' in b))
  assert.equal(b.free_food, true) // the rules' answer, untouched
  assert.equal(out.filter((r) => 'classifier' in r).length, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.answered, 2)
  assert.equal(summary.deferred, 1)
  assert.equal(summary.stopped, null)
  assert.match(warnings[0], /1 of 3 calls failed \(last: Jev responded 529\)/)

  // An answer that misses a question is a failure too.
  const partial = fakeJev(() => ({ free_food: { type: 'noul', noul: 0.9 } }))
  const { summary: partialSummary } = await classifyCampusEvents([row('d')], { client: database(), jev: partial, log: quiet })
  assert.equal(partialSummary.failed, 1)
})

test('a fatal error or five failures in a row stop the asking, not the run', async () => {
  const errors = []
  const log = { ...quiet, error: (line) => errors.push(line) }
  const rows = Array.from({ length: 8 }, (_, i) => row(`r${i}`))
  const badKey = fakeJev(() => {
    throw new JevError('Jev responded 401', { status: 401, fatal: true })
  })
  const stopped = await classifyCampusEvents(rows, { client: database(), jev: badKey, concurrency: 1, log })
  assert.equal(badKey.asked.length, 1)
  assert.match(stopped.summary.stopped, /^Jev error: Jev responded 401/)
  assert.equal(stopped.summary.deferred, 8)
  assert.deepEqual(stopped.rows, rows)
  assert.match(errors[0], /Jev stopped: Jev responded 401/)

  const down = fakeJev(() => {
    throw new JevError('Jev timed out')
  })
  const outage = await classifyCampusEvents(rows, { client: database(), jev: down, concurrency: 1, log: quiet })
  assert.equal(down.asked.length, 5)
  assert.equal(outage.summary.stopped, '5 failed calls in a row')
})

test('a run asks at most maxRows rows, soonest first, within its time budget', async () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((key) => row(key))
  const capped = fakeJev()
  const cap = await classifyCampusEvents(rows, { client: database(), jev: capped, maxRows: 2, concurrency: 1, log: quiet })
  assert.deepEqual(capped.asked, ['Event a', 'Event b'])
  assert.equal(cap.summary.stopped, 'row cap')
  assert.equal(cap.summary.deferred, 3)

  let time = 0
  const clock = () => time
  const slow = {
    asked: [],
    evaluate: async (state) => {
      slow.asked.push(state.title)
      time += 10_000
      return { model: JEV_MODEL, answers: answers(), usage: null }
    },
  }
  const budget = await classifyCampusEvents(rows, { client: database(), jev: slow, budgetMs: 25_000, concurrency: 1, clock, log: quiet })
  assert.equal(slow.asked.length, 3)
  assert.equal(budget.summary.stopped, 'time budget')
  assert.equal(budget.summary.deferred, 2)
  assert.equal(budget.summary.durationMs, 30_000)
})

test('a failed read of the stored verdicts rejects after one retry, as a failed write would', async () => {
  let reads = 0
  const flaky = database([], { fail: () => (++reads === 1 ? { data: null, error: { message: 'Gateway Timeout' }, status: 504 } : { data: [], error: null }) })
  const ok = await classifyCampusEvents([row('a')], { client: flaky, jev: fakeJev(), log: quiet, sleep: async () => {} })
  assert.equal(ok.summary.answered, 1)

  const missing = database([], { fail: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.campus_events'" }, status: 404 }) })
  const jev = fakeJev()
  await assert.rejects(classifyCampusEvents([row('a')], { client: missing, jev, log: quiet }), { code: 'PGRST205' })
  assert.equal(jev.asked.length, 0)

  const none = await classifyCampusEvents([], { client: missing, jev, log: quiet })
  assert.deepEqual(none.rows, [])
})

test('the classifier exists only when switched on with a key, and calls Jev on the pinned model', async () => {
  const warnings = []
  const log = { ...quiet, warn: (line) => warnings.push(line) }
  assert.equal(createCampusEventsClassifier({ apiKey: 'ts-key', setting: 'off', log }), null)
  assert.equal(createCampusEventsClassifier({ apiKey: 'ts-key', setting: undefined, log }), null)
  assert.equal(warnings.length, 0)
  assert.equal(createCampusEventsClassifier({ apiKey: '', setting: 'shadow', log }), null)
  assert.match(warnings[0], /CAMPUS_EVENTS_CLASSIFY is shadow but TYPESAFE_API_KEY is unset/)

  const sent = []
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ model: JEV_MODEL, answers: answers({ food: 0.99 }), usage: { input_tokens: 1200 } }), { status: 200 })
  }
  const classify = createCampusEventsClassifier({ apiKey: 'ts-key', setting: 'on', fetchImpl, log })
  assert.equal(typeof classify, 'function')
  assert.equal(classify.mode, 'on')
  const { rows, summary } = await classify([row('a', { title: 'Honors House Coffee' })], { client: database(), log: quiet })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, JEV_API_URL)
  assert.equal(sent[0].body.model, JEV_MODEL)
  assert.deepEqual(sent[0].body.questions, EVENT_QUESTIONS)
  assert.equal(sent[0].body.state.title, 'Honors House Coffee')
  assert.equal(rows[0].free_food, true)
  assert.equal(summary.mode, 'on')
})
