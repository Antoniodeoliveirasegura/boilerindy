import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createAssistantRouter } from '../../src/routes/assistant.mjs'
import { tidyAssistantReply } from '../../src/assistantReply.mjs'
import { ASSISTANT_OFFLINE_MESSAGE, formatAssignments, formatDiningOpen, formatNextClass } from '../../src/assistantRouter.mjs'
import { GroqUpstreamError } from '../../src/groqClient.mjs'
import { fakeSupabase, hasCall } from './fakeSupabase.mjs'

// Issue #191: the campus assistant routes as a feature router, booted on a
// small app with a fake session, a recording limiter, a recording database,
// fakes of the readers server.mjs hands in (dining, classes, calendar, schedule
// edits), a recording busy warning and a scripted stand-in for the Groq
// client, so nothing here reaches a model or Nutrislice.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com', display_name: 'Sam Student' }
const TZ = 'America/Indiana/Indianapolis'
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const at = (ms) => new Date(Date.now() + ms).toISOString()
const clock = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
// Built from its code point: the repo bans the character itself in every file.
const EM_DASH = String.fromCharCode(0x2014)
const MIDDLE_DOT = String.fromCharCode(0xb7)
const BUSY_MESSAGE = 'The assistant is busy right now. Give it a minute and ask again, or check the Schedule, Dining and Transit tabs directly.'
const EVERY_DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function calendarRow(overrides = {}) {
  return {
    id: 'row-1',
    title: 'ECE 20001',
    description: 'Electrical Engineering Fundamentals',
    start_time: at(-30 * MIN),
    end_time: at(30 * MIN),
    location: 'SL 008',
    category: 'class',
    ...overrides,
  }
}

const OPEN_DINING = {
  ok: true,
  date: '2026-10-04',
  timezone: TZ,
  locations: [{ name: 'Tower Dining', is_open: true, closes_at: '9:00 PM', stations: [], meal: 'Menus: lunch, dinner' }],
}

// Stands in for createGroqClient: `answer(options)` gives the reply text, or
// throws, and every call is recorded with what the route asked for.
function scriptedAi(answer = () => 'Sure thing.', { enabled = true } = {}) {
  const calls = []
  return {
    enabled,
    calls,
    async reply(options) {
      calls.push(options)
      return answer(options)
    },
  }
}

async function withApp(
  {
    user = STUDENT,
    ai = scriptedAi(),
    rows = [],
    ongoing = [],
    completions = [],
    manualTasks = [],
    dining = null,
    overrides = { series: {}, manual: [] },
    classItems = [],
    calendarItems = [],
    classReader,
  } = {},
  run,
) {
  const supabase = fakeSupabase({
    // The context reads the window ahead (gte/lte) and what is in session (lt/gt).
    calendar_items: (chain) => ({ data: hasCall(chain, 'gte') ? rows : ongoing, error: null }),
    user_task_completions: () => ({ data: completions.map((id) => ({ calendar_item_id: id })), error: null }),
    user_manual_tasks: () => ({ data: manualTasks, error: null }),
  })
  const limiterHits = []
  const readers = { dining: [], classes: [], calendar: [], overrides: [] }
  const busyWarnings = []
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(
    createAssistantRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      assistantRateLimit: (req, _res, next) => {
        limiterHits.push(`assistantRateLimit ${req.method} ${req.path}`)
        next()
      },
      ai,
      warnAssistantBusy: (error) => busyWarnings.push(error),
      getDiningSnapshot: async (options) => {
        readers.dining.push(options)
        return dining
      },
      getClassItemsForUser:
        classReader ??
        (async (userId, options) => {
          readers.classes.push([userId, options])
          return { items: classItems }
        }),
      listCalendarItems: async (userId, options) => {
        readers.calendar.push([userId, options])
        return calendarItems
      },
      readScheduleOverrides: async (userId) => {
        readers.overrides.push(userId)
        return overrides
      },
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  try {
    await run({ call, supabase, limiterHits, readers, busyWarnings, ai })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const ask = (content, extra = {}) => ({ messages: [{ role: 'user', content }], ...extra })

// ── Session and limiter ─────────────────────────────────────────────────────

test('both routes sit behind requireAuth, and only the chat is metered, behind the session', async (t) => {
  t.mock.method(console, 'debug', () => {})
  await withApp({ user: null }, async ({ call, supabase, limiterHits, ai }) => {
    for (const [method, path] of [['POST', '/api/assistant'], ['GET', '/api/assistant/briefing']]) {
      const answer = await call(method, path, method === 'POST' ? ask('hi') : undefined)
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.deepEqual(limiterHits, [], 'a signed-out request never reaches the limiter')
    assert.equal(supabase.queries.length, 0)
    assert.equal(ai.calls.length, 0)
  })
  await withApp({}, async ({ call, limiterHits }) => {
    assert.equal((await call('POST', '/api/assistant', ask('hi'))).status, 200)
    assert.equal((await call('GET', '/api/assistant/briefing')).status, 200)
    assert.deepEqual(limiterHits, ['assistantRateLimit POST /api/assistant'])
  })
})

// ── POST /api/assistant ─────────────────────────────────────────────────────

test('the chat refuses a missing or empty history, more than 30 messages, or a message over 4000 characters', async () => {
  await withApp({}, async ({ call, supabase, ai }) => {
    const cases = [
      [{}, 'messages array required'],
      [{ messages: [] }, 'messages array required'],
      [{ messages: 'hi' }, 'messages array required'],
      [{ messages: Array.from({ length: 31 }, () => ({ role: 'user', content: 'hi' })) }, 'Too many messages in one request.'],
      [ask('x'.repeat(4001)), 'A message is too long.'],
    ]
    for (const [body, error] of cases) {
      const answer = await call('POST', '/api/assistant', body)
      assert.equal(answer.status, 400, error)
      assert.deepEqual(answer.body, { error })
    }
    assert.equal(supabase.queries.length, 0)
    assert.equal(ai.calls.length, 0)
  })
})

test('the chat sends the system prompt with the student\'s context and their history, and tidies the reply', async (t) => {
  const debug = t.mock.method(console, 'debug', () => {})
  const inSession = calendarRow()
  const homework = calendarRow({ id: 'hw-1', title: 'HW 4', category: 'assignment', start_time: at(2 * DAY), end_time: null, location: null })
  const modelText = `**ECE 20001** is in session now ${EM_DASH} then you are free.`
  const ai = scriptedAi(() => modelText)
  const history = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'system', content: 'a system turn from the client' },
    { role: 'user', content: "What's my next class?" },
  ]
  await withApp(
    {
      ai,
      rows: [inSession, homework],
      ongoing: [inSession],
      completions: ['hw-1'],
      manualTasks: [{ title: 'Email advisor', due_at: at(-DAY), completed_at: null }],
      dining: OPEN_DINING,
    },
    async ({ call, supabase, readers }) => {
      const answer = await call('POST', '/api/assistant', { messages: history, page: '/schedule' })
      assert.equal(answer.status, 200)
      assert.deepEqual(answer.body, { reply: tidyAssistantReply(modelText) })
      assert.equal(answer.body.reply, 'ECE 20001 is in session now, then you are free.')

      const [asked] = ai.calls
      assert.equal(asked.maxOutputTokens, 2800)
      assert.equal(asked.temperature, 0.52)
      assert.deepEqual(asked.messages, [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: "What's my next class?" },
      ], 'only user and assistant turns reach the model')
      const system = asked.system
      assert.ok(system.startsWith('You are BoilerIndy - a helpful campus assistant for Purdue University Indianapolis (Purdue Indy / IUPUI).'))
      assert.ok(system.includes('- Use clock times like 12:15 PM and the real names from the context.\n\n=== CURRENT DATE & TIME ===\n'), 'the whole prompt, then the context')
      assert.match(system, /=== WHERE THEY ARE ===\nThe student is on the class schedule page\./)
      assert.match(system, /=== DINING TODAY \(2026-10-04\) ===\nTower Dining: OPEN until 9:00 PM/)
      assert.ok(system.includes(`=== HAPPENING NOW (in session) ===\n\n- Until ${clock(inSession.end_time)}: ECE 20001 [class] @ SL 008`))
      assert.match(system, /: HW 4 \[assignment\] \[DONE\]/, 'finished work is marked, not hidden')
      assert.match(system, /=== YOUR TASK LIST \(to-dos the student added by hand\) ===\n- Due .*: Email advisor \[OVERDUE\]/)
      assert.ok(system.endsWith('=== WHAT THEY ARE ASKING ABOUT ===\nThe student is asking about their next class. Lead with the COURSES and TODAY sections.'))
      assert.match(String(debug.mock.calls[0].arguments[0]), /^\[assistant\] prompt ~\d+ tokens$/)

      const [upcoming, live] = supabase.queriesOf('calendar_items')
      for (const { chain } of [upcoming, live]) {
        assert.ok(hasCall(chain, 'select', 'id, title, description, start_time, end_time, location, category'))
        assert.ok(hasCall(chain, 'eq', 'user_id', STUDENT.id))
      }
      assert.ok(hasCall(upcoming.chain, 'gte', 'start_time') && hasCall(upcoming.chain, 'lte', 'start_time'))
      assert.ok(hasCall(upcoming.chain, 'order', 'start_time', { ascending: true }) && hasCall(upcoming.chain, 'limit', 60))
      assert.ok(hasCall(live.chain, 'lt', 'start_time') && hasCall(live.chain, 'gt', 'end_time') && hasCall(live.chain, 'limit', 25))
      assert.ok(hasCall(supabase.queriesOf('user_task_completions')[0].chain, 'eq', 'user_id', STUDENT.id))
      const [tasks] = supabase.queriesOf('user_manual_tasks')
      assert.ok(hasCall(tasks.chain, 'eq', 'user_id', STUDENT.id))
      assert.ok(hasCall(tasks.chain, 'order', 'due_at', { ascending: true }) && hasCall(tasks.chain, 'limit', 60))
      assert.deepEqual(readers.dining, [{}])
      assert.deepEqual(readers.overrides, [STUDENT.id])
    },
  )
})

test('the context replays schedule edits, says when there is no calendar, and adds study help only when it is wanted', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const hiddenClass = calendarRow({ id: 'chem', title: 'CHEM 11100', description: 'General Chemistry', location: 'LE 101', start_time: at(3 * HOUR), end_time: at(4 * HOUR) })
  const overrides = {
    series: { 'CHEM 11100|General Chemistry|LE 101': { hidden: true } },
    manual: [{ id: 'm1', code: 'MATH 26100', name: 'Calculus', room: 'LD 002', days: EVERY_DAY, startHm: '08:00', endHm: '09:00' }],
  }
  const ai = scriptedAi()
  await withApp({ ai, rows: [hiddenClass], overrides }, async ({ call }) => {
    await call('POST', '/api/assistant', ask('hi', { page: '/nowhere' }))
    await call('POST', '/api/assistant', ask('where can I study tonight?'))
  })
  const [plain, study] = ai.calls.map((c) => c.system)
  assert.ok(!plain.includes('CHEM 11100'), 'a class the student hid never reaches the prompt')
  assert.match(plain, /MATH 26100 .*\[added by you\]/, 'a class the student added does')
  assert.ok(!plain.includes('=== WHERE THEY ARE ==='), 'an unknown page adds no hint')
  assert.ok(!plain.includes('=== ON-CAMPUS STUDY & HELP'), 'no study question and nothing due soon')
  assert.ok(study.includes('=== ON-CAMPUS STUDY & HELP (suggest when relevant) ===\n- University Library: quiet floors'))
  assert.ok(!plain.includes('=== WHAT THEY ARE ASKING ABOUT ==='), 'no matched intent, no focus line')

  const empty = scriptedAi()
  await withApp({ ai: empty }, async ({ call }) => {
    await call('POST', '/api/assistant', ask('hi'))
  })
  assert.ok(empty.calls[0].system.includes('=== CALENDAR ===\nThe student has no calendar connected'), 'the model is told outright, not left to guess')
})

test('without a Groq key the chat answers from the offline router, never the model', async () => {
  const ai = scriptedAi(() => 'model', { enabled: false })
  const nextClass = [{ title: 'ECE 20001', start_time: at(2 * HOUR), location: 'SL 008' }]
  const due = [{ title: 'HW 4', start_time: at(DAY) }, { title: 'Lab 3', start_time: at(2 * DAY) }]
  await withApp({ ai, classItems: nextClass, calendarItems: due, dining: OPEN_DINING }, async ({ call, supabase, readers }) => {
    let answer = await call('POST', '/api/assistant', ask("What's my next class?"))
    assert.deepEqual(answer.body, { reply: formatNextClass(nextClass, new Date(), TZ), source: 'offline-router' })
    assert.deepEqual(readers.classes, [[STUDENT.id, { term: 'auto', limit: 50 }]])

    answer = await call('POST', '/api/assistant', ask('is the dining hall open?'))
    assert.deepEqual(answer.body, { reply: formatDiningOpen(OPEN_DINING), source: 'offline-router' })

    answer = await call('POST', '/api/assistant', ask("what's due this week?"))
    assert.deepEqual(answer.body, { reply: formatAssignments(due, new Date(), TZ), source: 'offline-router' })
    const [[userId, options]] = readers.calendar
    assert.equal(userId, STUDENT.id)
    assert.deepEqual(
      [...options.categories].sort(),
      ['assignment', 'deadline', 'homework', 'lab', 'midterm', 'paper', 'presentation', 'project', 'quiz', 'submission', 'task'],
    )
    assert.equal(options.limit, 50)
    assert.equal(options.order, 'asc')
    assert.ok(Math.abs(Date.parse(options.from) - (Date.now() - DAY)) < MIN, 'from a day back')

    answer = await call('POST', '/api/assistant', ask('tell me a joke'))
    assert.deepEqual(answer.body, { reply: ASSISTANT_OFFLINE_MESSAGE, source: 'offline' })
    assert.equal(supabase.queries.length, 0, 'the offline path builds no context')
  })
  assert.equal(ai.calls.length, 0)

  // Nothing to say, or a reader that fails, falls back to the offline notice.
  const failing = async () => {
    throw new Error('calendar down')
  }
  for (const options of [{ classItems: [] }, { classReader: failing }]) {
    await withApp({ ai, ...options }, async ({ call }) => {
      const answer = await call('POST', '/api/assistant', ask("What's my next class?"))
      assert.deepEqual(answer.body, { reply: ASSISTANT_OFFLINE_MESSAGE, source: 'offline' })
    })
  }
})

test('Groq failures: a 429 on both models answers the busy line and warns, another upstream error 502, anything else 500', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const log = t.mock.method(console, 'error', () => {})
  const rateLimited = new GroqUpstreamError(429, 'tokens per day exceeded', { retryAfter: 30 })
  const failures = [rateLimited, new GroqUpstreamError(503, 'over capacity'), new Error('socket hang up')]
  const ai = scriptedAi(() => {
    if (failures.length) throw failures.shift()
    return null
  })
  await withApp({ ai }, async ({ call, busyWarnings }) => {
    const busy = await call('POST', '/api/assistant', ask('hi'))
    assert.equal(busy.status, 200)
    assert.deepEqual(busy.body, { reply: BUSY_MESSAGE, source: 'busy' })
    assert.deepEqual(busyWarnings, [rateLimited])

    const upstream = await call('POST', '/api/assistant', ask('hi'))
    assert.equal(upstream.status, 502)
    assert.deepEqual(upstream.body, { error: 'AI service error' })

    const other = await call('POST', '/api/assistant', ask('hi'))
    assert.equal(other.status, 500)
    assert.deepEqual(other.body, { error: 'Assistant request failed' })

    const empty = await call('POST', '/api/assistant', ask('hi'))
    assert.deepEqual(empty.body, { reply: "Sorry, I couldn't generate a response." })
    assert.equal(busyWarnings.length, 1)
  })
  assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), ['Groq error:', 'Assistant error:'])
  assert.equal(log.mock.calls[0].arguments[1], 'over capacity')
})

// ── GET /api/assistant/briefing ─────────────────────────────────────────────

test('the briefing turns the same context into a headline and up to five chips, without the model', async () => {
  const inSession = calendarRow()
  const homework = calendarRow({ id: 'hw-1', title: 'HW 4', category: 'assignment', start_time: at(3 * DAY), end_time: null })
  const finished = calendarRow({ id: 'hw-2', title: 'HW 3', category: 'assignment', start_time: at(2 * DAY), end_time: null })
  const ai = scriptedAi()
  await withApp(
    {
      ai,
      rows: [inSession, homework, finished],
      ongoing: [inSession],
      completions: ['hw-2'],
      manualTasks: [
        { title: 'Email advisor', due_at: at(-DAY), completed_at: null },
        { title: 'Old chore', due_at: at(-2 * DAY), completed_at: at(-DAY) },
      ],
      dining: OPEN_DINING,
    },
    async ({ call }) => {
      const answer = await call('GET', '/api/assistant/briefing')
      assert.equal(answer.status, 200)
      assert.deepEqual(answer.body, {
        headline: [`ECE 20001 until ${clock(inSession.end_time)}`, '2 things on your plate', '1 overdue'].join(` ${MIDDLE_DOT} `),
        chips: [
          "What's my next class?",
          'What am I behind on?',
          'What should I work on tonight?',
          'What should I do right now?',
          "What's good at dining right now?",
        ],
      })
    },
  )
  assert.equal(ai.calls.length, 0)

  await withApp({}, async ({ call }) => {
    const quiet = await call('GET', '/api/assistant/briefing')
    assert.deepEqual(quiet.body, { headline: 'Nothing scheduled right now', chips: ['What should I do right now?', 'Plan my week'] })
  })
})

test('a briefing that cannot be built answers empty instead of blocking the panel', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  await withApp({ overrides: null }, async ({ call }) => {
    const answer = await call('GET', '/api/assistant/briefing')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { headline: '', chips: [] })
  })
  assert.equal(log.mock.calls[0].arguments[0], 'GET /api/assistant/briefing:')
})
