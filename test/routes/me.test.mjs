import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createMeRouter } from '../../src/routes/me.mjs'
import { DEFAULT_CREDIT_HOURS, DEFAULT_TERM, MAX_COURSE_NAME, MAX_CREDIT_HOURS } from '../../src/gradeTracker.mjs'
import { mapManualTaskRow } from '../../src/manualTasks.mjs'
import { normalizeScheduleOverrides } from '../../src/scheduleOverrides.mjs'
import { GRADES_CAP_MESSAGE, MANUAL_TASKS_CAP_MESSAGE, MAX_GRADES, MAX_MANUAL_TASKS } from '../../src/userWriteCaps.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the student's calendar, task, grade, degree and schedule-edit
// routes as a feature router, booted on a small app with the body handling
// server.mjs runs ahead of it, a fake session, a recording limiter, a
// recording database and recording fakes of the three calendar readers that
// server.mjs builds once (src/calendarReads.mjs) and hands in.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com', major: 'computer-science' }
const TASK_ID = '55555555-5555-4555-8555-555555555555'
const GRADE_ID = '66666666-6666-4666-8666-666666666666'
const GRADE_2 = '88888888-8888-4888-8888-888888888888'
const ITEM_ID = '77777777-7777-4777-8777-777777777777'
const SIGNED_OUT = { error: { message: 'You must sign in to access this resource.', status: 401 } }
const NOT_FOUND = { error: { message: 'Not found.', status: 404 } }
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DAY_MS = 24 * 60 * 60 * 1000
const NO_CLASSES = { items: [], meta: { selectedTermKey: null, selectedTermLabel: null, totalInTerm: 0 } }

async function withApp({ user = STUDENT, handlers = {}, readers = {} } = {}, run) {
  // No default tables: a query a test did not expect throws in the fake.
  const supabase = fakeSupabase(handlers)
  const limiterHits = []
  const readerCalls = []
  const reader = (name, fallback) => async (...args) => {
    readerCalls.push({ name, args })
    return readers[name] ? readers[name](...args) : fallback
  }
  const app = express()
  // The app-level body handling server.mjs registers ahead of every route.
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {}
    next()
  })
  app.use(
    createMeRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json(SIGNED_OUT)
        req.currentUser = user
        next()
      },
      userWriteRateLimit: (req, _res, next) => {
        limiterHits.push(`userWriteRateLimit ${req.method} ${req.path}`)
        next()
      },
      listCalendarItems: reader('listCalendarItems', []),
      getClassItemsForUser: reader('getClassItemsForUser', NO_CLASSES),
      readScheduleOverrides: reader('readScheduleOverrides', { series: {}, manual: [] }),
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
    await run({ call, supabase, limiterHits, readerCalls })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const ROUTES = [
  ['GET', '/api/me/calendar'],
  ['GET', '/api/me/calendar/categories'],
  ['GET', '/api/me/tasks/meta'],
  ['POST', '/api/me/tasks/calendar/complete'],
  ['POST', '/api/me/tasks/manual'],
  ['PATCH', `/api/me/tasks/manual/${TASK_ID}`],
  ['DELETE', `/api/me/tasks/manual/${TASK_ID}`],
  ['GET', '/api/me/grades'],
  ['POST', '/api/me/grades'],
  ['PATCH', `/api/me/grades/${GRADE_ID}`],
  ['DELETE', `/api/me/grades/${GRADE_ID}`],
  ['GET', '/api/me/degree'],
  ['PUT', '/api/me/degree'],
  ['GET', '/api/me/schedule-overrides'],
  ['PUT', '/api/me/schedule-overrides'],
  ['GET', '/api/me/classes'],
  ['GET', '/api/me/events'],
]
const WRITES = ROUTES.filter(([method]) => method !== 'GET')

function assertAboutDaysAgo(iso, days) {
  assert.match(iso, ISO)
  const drift = Math.abs(Date.parse(iso) - (Date.now() - days * DAY_MS))
  assert.ok(drift < 60_000, `${iso} is not ${days} days back`)
}

test('every route answers 401 signed out, before any query or reader call', async () => {
  assert.equal(ROUTES.length, 17)
  await withApp({ user: null }, async ({ call, supabase, readerCalls }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path, method === 'GET' ? undefined : {})
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, SIGNED_OUT, `${method} ${path}`)
    }
    assert.equal(supabase.queries.length + supabase.rpcCalls.length, 0)
    assert.deepEqual(readerCalls, [])
  })
})

test('signed out, user-write still meters the nine writes, so it runs ahead of requireAuth, and none of the reads', async () => {
  await withApp({ user: null }, async ({ call, limiterHits }) => {
    for (const [method, path] of ROUTES) await call(method, path, method === 'GET' ? undefined : {})
    assert.equal(WRITES.length, 9)
    assert.deepEqual(limiterHits, WRITES.map(([method, path]) => `userWriteRateLimit ${method} ${path}`))
  })
})

test('a malformed :id answers 404 Not found. after the limiter, before requireAuth and any query', async () => {
  const malformed = [
    ['PATCH', '/api/me/tasks/manual/not-a-uuid'],
    ['DELETE', '/api/me/tasks/manual/not-a-uuid'],
    ['PATCH', '/api/me/grades/not-a-uuid'],
    ['DELETE', '/api/me/grades/not-a-uuid'],
  ]
  for (const user of [null, STUDENT]) {
    await withApp({ user }, async ({ call, supabase, limiterHits }) => {
      for (const [method, path] of malformed) {
        const answer = await call(method, path, { completed: true, letterGrade: 'A' })
        assert.equal(answer.status, 404, `${method} ${path}`)
        assert.deepEqual(answer.body, NOT_FOUND, `${method} ${path}`)
      }
      assert.deepEqual(limiterHits, malformed.map(([method, path]) => `userWriteRateLimit ${method} ${path}`))
      assert.equal(supabase.queries.length, 0)
    })
  }
})

test('GET /api/me/calendar hands listCalendarItems the filters, ascending, from 14 days back unless ?from= is given', async () => {
  const items = [{ id: 'c1', title: 'CS 18000 Lecture' }]
  await withApp({ readers: { listCalendarItems: () => items } }, async ({ call, readerCalls, supabase }) => {
    const plain = await call('GET', '/api/me/calendar')
    assert.equal(plain.status, 200)
    assert.deepEqual(plain.body, { items })
    const [{ name, args: [userId, options] }] = readerCalls
    assert.equal(name, 'listCalendarItems')
    assert.equal(userId, STUDENT.id)
    const { from, ...rest } = options
    assert.deepEqual(rest, { category: null, categories: null, limit: 100, order: 'asc' })
    assertAboutDaysAgo(from, 14)

    await call('GET', '/api/me/calendar?category=exam&categories=exam,,quiz&limit=5&from=2026-09-01T00:00:00.000Z')
    assert.deepEqual(readerCalls[1].args, [
      STUDENT.id,
      { category: 'exam', categories: ['exam', 'quiz'], limit: 5, order: 'asc', from: '2026-09-01T00:00:00.000Z' },
    ])
    assert.equal(supabase.queries.length, 0, 'the injected reader does the querying')
  })
})

test('GET /api/me/events reads category event, 20 by default, from 14 days back unless ?from= is given', async () => {
  const items = [{ id: 'e1', title: 'Involvement fair', freeFood: true }]
  await withApp({ readers: { listCalendarItems: () => items } }, async ({ call, readerCalls }) => {
    const plain = await call('GET', '/api/me/events')
    assert.equal(plain.status, 200)
    assert.deepEqual(plain.body, { items })
    const { from, ...rest } = readerCalls[0].args[1]
    assert.equal(readerCalls[0].args[0], STUDENT.id)
    assert.deepEqual(rest, { category: 'event', limit: 20, order: 'asc' })
    assertAboutDaysAgo(from, 14)

    await call('GET', '/api/me/events?limit=3&from=2026-10-01T00:00:00.000Z')
    assert.deepEqual(readerCalls[1].args, [STUDENT.id, { category: 'event', limit: 3, order: 'asc', from: '2026-10-01T00:00:00.000Z' }])
  })
})

test('GET /api/me/classes answers getClassItemsForUser: limit 20, the auto term and display mode unless asked otherwise', async () => {
  const classes = { items: [{ id: 'c1' }], meta: { selectedTermKey: '2026-fall', selectedTermLabel: 'Fall 2026', totalInTerm: 1 } }
  await withApp({ readers: { getClassItemsForUser: () => classes } }, async ({ call, readerCalls }) => {
    const answer = await call('GET', '/api/me/classes')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, classes)
    await call('GET', '/api/me/classes?limit=50&term=2026-spring&mode=list')
    assert.deepEqual(readerCalls, [
      { name: 'getClassItemsForUser', args: [STUDENT.id, { limit: 20, term: 'auto', mode: 'display' }] },
      { name: 'getClassItemsForUser', args: [STUDENT.id, { limit: 50, term: '2026-spring', mode: 'list' }] },
    ])
  })
})

test('GET /api/me/calendar/categories counts through calendar_category_counts for the student; an error answers none', async () => {
  const rpc = () => ({ data: [{ category: 'exam', item_count: 3 }, { category: 'class', item_count: 12 }], error: null })
  await withApp({ handlers: { rpc } }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/calendar/categories')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, {
      categories: [
        { id: 'class', label: 'Classes', count: 12 },
        { id: 'exam', label: 'Exams', count: 3 },
      ],
    })
    assert.deepEqual(
      supabase.rpcCalls.map(({ name, args }) => ({ name, args })),
      [{ name: 'calendar_category_counts', args: { p_user_id: STUDENT.id } }],
    )
  })
  const failing = () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
  await withApp({ handlers: { rpc: failing } }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/calendar/categories')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { categories: [] })
    assert.equal(supabase.queries.length, 0, 'only a missing function falls back to counting rows')
  })
})

test('GET /api/me/tasks/meta: completions from 120 days back, open or recently done manual tasks, 1000 rows each', async () => {
  const completions = [{ calendar_item_id: ITEM_ID, completed_at: '2026-10-01T12:00:00.000Z' }]
  const manual = [{ id: TASK_ID, title: 'Email advisor', due_at: null, completed_at: null }]
  const handlers = {
    user_task_completions: () => ({ data: completions, error: null }),
    user_manual_tasks: () => ({ data: manual, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/tasks/meta')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { completions, manualTasks: manual.map(mapManualTaskRow) })

    const [{ chain: done }] = supabase.queriesOf('user_task_completions')
    assert.deepEqual(done.map((call) => call.method), ['select', 'eq', 'gte', 'order', 'limit'])
    assert.ok(hasCall(done, 'select', 'calendar_item_id, completed_at'))
    assert.ok(hasCall(done, 'eq', 'user_id', STUDENT.id))
    assert.equal(done[2].args[0], 'completed_at')
    assertAboutDaysAgo(done[2].args[1], 120)
    assert.ok(hasCall(done, 'order', 'completed_at', { ascending: false }))
    assert.ok(hasCall(done, 'limit', 1000))

    const [{ chain: tasks }] = supabase.queriesOf('user_manual_tasks')
    assert.deepEqual(tasks.map((call) => call.method), ['select', 'eq', 'or', 'order', 'limit'])
    assert.ok(hasCall(tasks, 'select', '*'))
    assert.ok(hasCall(tasks, 'eq', 'user_id', STUDENT.id))
    const bound = /^completed_at\.is\.null,completed_at\.gte\.(.+)$/.exec(tasks[2].args[0])
    assert.ok(bound, tasks[2].args[0])
    assertAboutDaysAgo(bound[1], 60)
    assert.ok(hasCall(tasks, 'order', 'due_at', { ascending: true }))
    assert.ok(hasCall(tasks, 'limit', 1000))
  })
})

test('GET /api/me/tasks/meta answers unavailable when either read fails', async (t) => {
  t.mock.method(console, 'error', () => {})
  for (const failing of ['user_task_completions', 'user_manual_tasks']) {
    const handlers = {
      user_task_completions: () => ({ data: [], error: null }),
      user_manual_tasks: () => ({ data: [], error: null }),
      [failing]: () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }),
    }
    await withApp({ handlers }, async ({ call }) => {
      const answer = await call('GET', '/api/me/tasks/meta')
      assert.equal(answer.status, 200, failing)
      assert.deepEqual(answer.body, { completions: [], manualTasks: [], unavailable: true }, failing)
    })
  }
})

test("POST /api/me/tasks/calendar/complete: 400 without an item and a boolean, 404 for another student's item", async () => {
  const handlers = { calendar_items: () => ({ data: null, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    for (const body of [{}, { calendarItemId: ITEM_ID }, { calendarItemId: ITEM_ID, completed: 'yes' }, { completed: true }]) {
      const answer = await call('POST', '/api/me/tasks/calendar/complete', body)
      assert.equal(answer.status, 400, JSON.stringify(body))
      assert.deepEqual(answer.body, { error: { message: 'calendarItemId and completed (boolean) required', status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)

    const answer = await call('POST', '/api/me/tasks/calendar/complete', { calendarItemId: ITEM_ID, completed: true })
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, { error: { message: 'Calendar item not found' } })
    assert.deepEqual(supabase.queriesOf('calendar_items')[0].chain, [
      { method: 'select', args: ['id'] },
      { method: 'eq', args: ['id', ITEM_ID] },
      { method: 'eq', args: ['user_id', STUDENT.id] },
      { method: 'maybeSingle', args: [] },
    ])
    assert.equal(supabase.queriesOf('user_task_completions').length, 0)
  })
})

test('POST /api/me/tasks/calendar/complete: done inserts, a repeat (23505) updates, undone deletes, each for the student and item', async () => {
  let insertError = null
  const handlers = {
    calendar_items: () => ({ data: { id: ITEM_ID }, error: null }),
    user_task_completions: (chain) => ({ data: null, error: operation(chain) === 'insert' ? insertError : null }),
  }
  const scoped = [
    { method: 'eq', args: ['user_id', STUDENT.id] },
    { method: 'eq', args: ['calendar_item_id', ITEM_ID] },
  ]
  await withApp({ handlers }, async ({ call, supabase }) => {
    const done = await call('POST', '/api/me/tasks/calendar/complete', { calendarItemId: ITEM_ID, completed: true })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body, { ok: true })
    const [insert] = supabase.queriesOf('user_task_completions')
    const row = insert.chain[0].args[0]
    assert.deepEqual(insert.chain, [{ method: 'insert', args: [{ user_id: STUDENT.id, calendar_item_id: ITEM_ID, completed_at: row.completed_at }] }])
    assert.match(row.completed_at, ISO)

    insertError = { code: '23505', message: 'duplicate key value violates unique constraint' }
    const again = await call('POST', '/api/me/tasks/calendar/complete', { calendarItemId: ITEM_ID, completed: true })
    assert.equal(again.status, 200)
    assert.deepEqual(again.body, { ok: true })
    const [, retry, update] = supabase.queriesOf('user_task_completions')
    assert.equal(operation(retry.chain), 'insert')
    assert.equal(update.chain[0].method, 'update')
    assert.match(update.chain[0].args[0].completed_at, ISO)
    assert.deepEqual(update.chain.slice(1), scoped)

    const undone = await call('POST', '/api/me/tasks/calendar/complete', { calendarItemId: ITEM_ID, completed: false })
    assert.deepEqual(undone.body, { ok: true })
    assert.deepEqual(supabase.queriesOf('user_task_completions').at(-1).chain, [{ method: 'delete', args: [] }, ...scoped])
    for (const { chain } of supabase.queriesOf('calendar_items')) assert.ok(hasCall(chain, 'eq', 'user_id', STUDENT.id))
  })
})

test("POST /api/me/tasks/manual: the parser's 400s come before any query", async () => {
  await withApp({}, async ({ call, supabase }) => {
    for (const [body, message] of [
      [{}, 'Title is required (max 500 characters)'],
      [{ title: '   ' }, 'Title is required (max 500 characters)'],
      [{ title: 'Read ch. 4', dueAt: 'next tuesday' }, 'Invalid dueAt date'],
      [{ title: 'Read ch. 4', dueAt: 42 }, 'dueAt must be an ISO timestamp string'],
    ]) {
      const answer = await call('POST', '/api/me/tasks/manual', body)
      assert.equal(answer.status, 400, JSON.stringify(body))
      assert.deepEqual(answer.body, { error: { message, status: 400 } })
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('POST /api/me/tasks/manual: 409 at the cap with nothing inserted, otherwise inserted for the student and mapped', async () => {
  let count = MAX_MANUAL_TASKS
  const created = { id: TASK_ID, title: 'Read ch. 4', due_at: '2026-10-09T03:59:00.000Z', completed_at: null }
  const handlers = {
    user_manual_tasks: (chain) => (operation(chain) === 'insert' ? { data: created, error: null } : { data: null, count, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const full = await call('POST', '/api/me/tasks/manual', { title: 'Read ch. 4', dueAt: created.due_at })
    assert.equal(full.status, 409)
    assert.deepEqual(full.body, { error: { message: MANUAL_TASKS_CAP_MESSAGE, status: 409 } })
    assert.deepEqual(supabase.queriesOf('user_manual_tasks').map((q) => q.chain), [
      [
        { method: 'select', args: ['id', { count: 'exact', head: true }] },
        { method: 'eq', args: ['user_id', STUDENT.id] },
      ],
    ])

    count = MAX_MANUAL_TASKS - 1
    const answer = await call('POST', '/api/me/tasks/manual', { title: '  Read ch. 4 ', dueAt: created.due_at })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { task: mapManualTaskRow(created) })
    assert.deepEqual(supabase.queriesOf('user_manual_tasks').at(-1).chain, [
      { method: 'insert', args: [{ user_id: STUDENT.id, title: 'Read ch. 4', due_at: created.due_at }] },
      { method: 'select', args: [] },
      { method: 'single', args: [] },
    ])
  })
})

test("PATCH /api/me/tasks/manual/:id: the parser's 400, 404 Task not found. for another student's task, else the scoped update", async () => {
  let row = null
  const handlers = { user_manual_tasks: () => ({ data: row, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const empty = await call('PATCH', `/api/me/tasks/manual/${TASK_ID}`, {})
    assert.equal(empty.status, 400)
    assert.deepEqual(empty.body, { error: { message: 'No valid fields to update', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const missing = await call('PATCH', `/api/me/tasks/manual/${TASK_ID}`, { completed: true })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Task not found.', status: 404 } })
    const [update] = supabase.queriesOf('user_manual_tasks')
    const updates = update.chain[0].args[0]
    assert.match(updates.completed_at, ISO)
    assert.deepEqual(update.chain, [
      { method: 'update', args: [{ completed_at: updates.completed_at }] },
      { method: 'eq', args: ['id', TASK_ID] },
      { method: 'eq', args: ['user_id', STUDENT.id] },
      { method: 'select', args: [] },
      { method: 'maybeSingle', args: [] },
    ])

    row = { id: TASK_ID, title: 'Renamed', due_at: null, completed_at: null }
    const renamed = await call('PATCH', `/api/me/tasks/manual/${TASK_ID}`, { title: 'Renamed', dueAt: null })
    assert.equal(renamed.status, 200)
    assert.deepEqual(renamed.body, { task: mapManualTaskRow(row) })
    assert.ok(hasCall(supabase.queriesOf('user_manual_tasks').at(-1).chain, 'update', { title: 'Renamed', due_at: null }))
  })
})

test('DELETE /api/me/tasks/manual/:id deletes by id and the student', async () => {
  const handlers = { user_manual_tasks: () => ({ data: null, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('DELETE', `/api/me/tasks/manual/${TASK_ID}`)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    assert.deepEqual(supabase.queriesOf('user_manual_tasks')[0].chain, [
      { method: 'delete', args: [] },
      { method: 'eq', args: ['id', TASK_ID] },
      { method: 'eq', args: ['user_id', STUDENT.id] },
    ])
  })
})

test("GET /api/me/grades lists the student's courses oldest first, mapped; a failed read answers unavailable", async (t) => {
  const rows = [
    { id: GRADE_ID, user_id: STUDENT.id, course_name: 'CS 18000', term: 'Fall 2026', credit_hours: '4.00', letter_grade: 'A-', created_at: '2026-09-01T00:00:00Z' },
    { id: GRADE_2, user_id: STUDENT.id, course_name: 'MA 16500', term: 'Other', credit_hours: 3, letter_grade: 'P', created_at: '2026-09-02T00:00:00Z' },
  ]
  await withApp({ handlers: { user_grades: () => ({ data: rows, error: null }) } }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/grades')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, {
      grades: [
        { id: GRADE_ID, courseName: 'CS 18000', term: 'Fall 2026', creditHours: 4, letterGrade: 'A-' },
        { id: GRADE_2, courseName: 'MA 16500', term: 'Other', creditHours: 3, letterGrade: 'P' },
      ],
    })
    assert.deepEqual(supabase.queriesOf('user_grades')[0].chain, [
      { method: 'select', args: ['*'] },
      { method: 'eq', args: ['user_id', STUDENT.id] },
      { method: 'order', args: ['created_at', { ascending: true }] },
    ])
  })
  t.mock.method(console, 'error', () => {})
  await withApp({ handlers: { user_grades: () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }) } }, async ({ call }) => {
    const answer = await call('GET', '/api/me/grades')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { grades: [], unavailable: true })
  })
})

test('POST /api/me/grades: parseGradeBody answers 400 for a bad course, letter or credit hours, before any query', async () => {
  const nameMessage = `Course name is required (max ${MAX_COURSE_NAME} characters)`
  const hoursMessage = `Credit hours must be between 0 and ${MAX_CREDIT_HOURS}`
  await withApp({}, async ({ call, supabase }) => {
    for (const [body, message] of [
      [{ letterGrade: 'A' }, nameMessage],
      [{ courseName: '   ', letterGrade: 'A' }, nameMessage],
      [{ courseName: 'x'.repeat(MAX_COURSE_NAME + 1), letterGrade: 'A' }, nameMessage],
      [{ courseName: 'CS 18000' }, 'A valid letter grade is required'],
      [{ courseName: 'CS 18000', letterGrade: 'E' }, 'A valid letter grade is required'],
      [{ courseName: 'CS 18000', letterGrade: 'A', creditHours: MAX_CREDIT_HOURS + 1 }, hoursMessage],
      [{ courseName: 'CS 18000', letterGrade: 'A', creditHours: -1 }, hoursMessage],
      [{ courseName: 'CS 18000', letterGrade: 'A', creditHours: 'four' }, hoursMessage],
    ]) {
      const answer = await call('POST', '/api/me/grades', body)
      assert.equal(answer.status, 400, JSON.stringify(body))
      assert.deepEqual(answer.body, { error: { message, status: 400 } }, JSON.stringify(body))
    }
    assert.equal(supabase.queries.length, 0)
  })
})

test('POST /api/me/grades: 409 at the cap with nothing inserted, otherwise the coerced row for the student', async () => {
  let count = MAX_GRADES
  let created = null
  const handlers = {
    user_grades: (chain) => {
      if (operation(chain) !== 'insert') return { data: null, count, error: null }
      created = { id: GRADE_ID, ...chain[0].args[0] }
      return { data: created, error: null }
    },
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const full = await call('POST', '/api/me/grades', { courseName: 'CS 18000', letterGrade: 'A' })
    assert.equal(full.status, 409)
    assert.deepEqual(full.body, { error: { message: GRADES_CAP_MESSAGE, status: 409 } })
    assert.deepEqual(supabase.queriesOf('user_grades').map((q) => q.chain), [
      [
        { method: 'select', args: ['id', { count: 'exact', head: true }] },
        { method: 'eq', args: ['user_id', STUDENT.id] },
      ],
    ])

    count = MAX_GRADES - 1
    const defaults = await call('POST', '/api/me/grades', { courseName: '  CS 18000 ', letterGrade: 'A' })
    assert.equal(defaults.status, 200)
    assert.deepEqual(supabase.queriesOf('user_grades').at(-1).chain, [
      { method: 'insert', args: [{ user_id: STUDENT.id, course_name: 'CS 18000', letter_grade: 'A', term: DEFAULT_TERM, credit_hours: DEFAULT_CREDIT_HOURS }] },
      { method: 'select', args: [] },
      { method: 'single', args: [] },
    ])
    assert.deepEqual(defaults.body, {
      grade: { id: GRADE_ID, courseName: 'CS 18000', term: DEFAULT_TERM, creditHours: DEFAULT_CREDIT_HOURS, letterGrade: 'A' },
    })

    const coerced = await call('POST', '/api/me/grades', { courseName: 'MA 16500', letterGrade: 'B+', term: '  Fall 2026 ', creditHours: '3.456' })
    assert.deepEqual(coerced.body, { grade: { id: GRADE_ID, courseName: 'MA 16500', term: 'Fall 2026', creditHours: 3.46, letterGrade: 'B+' } })
  })
})

test("PATCH /api/me/grades/:id: 400 with nothing valid to update, 404 Course not found. for another student's course, else the scoped update", async () => {
  let row = null
  const handlers = { user_grades: () => ({ data: row, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const empty = await call('PATCH', `/api/me/grades/${GRADE_ID}`, { unknown: 1 })
    assert.equal(empty.status, 400)
    assert.deepEqual(empty.body, { error: { message: 'No valid fields to update', status: 400 } })
    const invalid = await call('PATCH', `/api/me/grades/${GRADE_ID}`, { letterGrade: 'Z' })
    assert.equal(invalid.status, 400)
    assert.deepEqual(invalid.body, { error: { message: 'A valid letter grade is required', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const missing = await call('PATCH', `/api/me/grades/${GRADE_ID}`, { letterGrade: 'B' })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Course not found.', status: 404 } })
    assert.deepEqual(supabase.queriesOf('user_grades')[0].chain, [
      { method: 'update', args: [{ letter_grade: 'B' }] },
      { method: 'eq', args: ['id', GRADE_ID] },
      { method: 'eq', args: ['user_id', STUDENT.id] },
      { method: 'select', args: [] },
      { method: 'maybeSingle', args: [] },
    ])

    row = { id: GRADE_ID, course_name: 'CS 18000', term: 'Fall 2026', credit_hours: '4.00', letter_grade: 'B' }
    const updated = await call('PATCH', `/api/me/grades/${GRADE_ID}`, { letterGrade: 'B' })
    assert.equal(updated.status, 200)
    assert.deepEqual(updated.body, { grade: { id: GRADE_ID, courseName: 'CS 18000', term: 'Fall 2026', creditHours: 4, letterGrade: 'B' } })
  })
})

test('DELETE /api/me/grades/:id deletes by id and the student', async () => {
  const handlers = { user_grades: () => ({ data: null, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('DELETE', `/api/me/grades/${GRADE_ID}`)
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    assert.deepEqual(supabase.queriesOf('user_grades')[0].chain, [
      { method: 'delete', args: [] },
      { method: 'eq', args: ['id', GRADE_ID] },
      { method: 'eq', args: ['user_id', STUDENT.id] },
    ])
  })
})

test("GET /api/me/degree answers the session user's major, or null, without a query", async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/degree')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { major: 'computer-science' })
    assert.equal(supabase.queries.length, 0)
  })
  await withApp({ user: { ...STUDENT, major: undefined } }, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/me/degree')).body, { major: null })
  })
})

test('PUT /api/me/degree: an unknown major is a 400 before any write; a known one, or null to clear, is saved on the student row', async () => {
  const handlers = { users: () => ({ data: null, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const unknown = await call('PUT', '/api/me/degree', { major: 'nope' })
    assert.equal(unknown.status, 400)
    assert.deepEqual(unknown.body, { error: { message: 'Unknown major', status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const set = await call('PUT', '/api/me/degree', { major: 'data-science' })
    assert.equal(set.status, 200)
    assert.deepEqual(set.body, { major: 'data-science' })
    for (const body of [{ major: null }, { major: '' }, {}]) {
      const cleared = await call('PUT', '/api/me/degree', body)
      assert.deepEqual(cleared.body, { major: null }, JSON.stringify(body))
    }
    const chains = supabase.queriesOf('users').map((q) => q.chain)
    assert.deepEqual(chains, [
      [{ method: 'update', args: [{ major: 'data-science' }] }, { method: 'eq', args: ['id', STUDENT.id] }],
      ...Array.from({ length: 3 }, () => [{ method: 'update', args: [{ major: null }] }, { method: 'eq', args: ['id', STUDENT.id] }]),
    ])
  })
})

test('GET /api/me/schedule-overrides answers the reader for the student; a throwing reader answers the empty shape, unavailable', async (t) => {
  const stored = { series: { 'CS 18000|Lecture': { hidden: true } }, manual: [] }
  await withApp({ readers: { readScheduleOverrides: () => stored } }, async ({ call, readerCalls }) => {
    const answer = await call('GET', '/api/me/schedule-overrides')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { overrides: stored })
    assert.deepEqual(readerCalls, [{ name: 'readScheduleOverrides', args: [STUDENT.id] }])
  })
  t.mock.method(console, 'error', () => {})
  const throwing = () => {
    throw new Error('fetch failed')
  }
  await withApp({ readers: { readScheduleOverrides: throwing } }, async ({ call }) => {
    const answer = await call('GET', '/api/me/schedule-overrides')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { overrides: { series: {}, manual: [] }, unavailable: true })
  })
})

test('PUT /api/me/schedule-overrides upserts the normalized document on user_id and answers it', async () => {
  const sent = { series: { 'CS 18000|Lecture': { code: ' CS 18000 ', startHm: '9:05', hidden: true, junk: 1 } }, manual: 'nope' }
  const normalized = normalizeScheduleOverrides(sent)
  assert.deepEqual(normalized, { series: { 'CS 18000|Lecture': { code: 'CS 18000', startHm: '09:05', hidden: true } }, manual: [] })
  const handlers = { user_schedule_overrides: () => ({ data: null, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('PUT', '/api/me/schedule-overrides', { overrides: sent })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { overrides: normalized })
    const [{ chain }] = supabase.queriesOf('user_schedule_overrides')
    assert.equal(chain.length, 1)
    assert.equal(chain[0].method, 'upsert')
    const [row, options] = chain[0].args
    assert.match(row.updated_at, ISO)
    assert.deepEqual(row, { user_id: STUDENT.id, series: normalized.series, manual: normalized.manual, updated_at: row.updated_at })
    assert.deepEqual(options, { onConflict: 'user_id' })
  })
})

test('a failed write answers its 500 fallback without the database text, and a not-found code answers 404', async (t) => {
  const log = t.mock.method(console, 'error', () => {})
  const failed = { data: null, error: { code: '42P01', message: 'relation "secret_table" does not exist' } }
  const handlers = {
    calendar_items: () => ({ data: { id: ITEM_ID }, error: null }),
    user_task_completions: () => failed,
    user_manual_tasks: () => failed,
    user_grades: () => failed,
    users: () => failed,
    user_schedule_overrides: () => failed,
  }
  await withApp({ handlers }, async ({ call }) => {
    for (const [method, path, body, message] of [
      ['POST', '/api/me/tasks/calendar/complete', { calendarItemId: ITEM_ID, completed: false }, 'Could not update completion'],
      ['POST', '/api/me/tasks/manual', { title: 'Read ch. 4' }, 'Could not create task'],
      ['PATCH', `/api/me/tasks/manual/${TASK_ID}`, { completed: true }, 'Could not update task'],
      ['DELETE', `/api/me/tasks/manual/${TASK_ID}`, undefined, 'Could not delete task'],
      ['POST', '/api/me/grades', { courseName: 'CS 18000', letterGrade: 'A' }, 'Could not save course'],
      ['PATCH', `/api/me/grades/${GRADE_ID}`, { letterGrade: 'B' }, 'Could not update course'],
      ['DELETE', `/api/me/grades/${GRADE_ID}`, undefined, 'Could not delete course'],
    ]) {
      const answer = await call(method, path, body)
      assert.equal(answer.status, 500, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message, status: 500 } }, `${method} ${path}`)
    }
    // These two answer the older envelope, without a status field.
    const degree = await call('PUT', '/api/me/degree', { major: 'data-science' })
    assert.equal(degree.status, 500)
    assert.deepEqual(degree.body, { error: { message: 'Could not save your major.' } })
    const overrides = await call('PUT', '/api/me/schedule-overrides', { overrides: {} })
    assert.equal(overrides.status, 500)
    assert.deepEqual(overrides.body, { error: { message: 'Could not save schedule changes.' } })
  })
  assert.ok(log.mock.calls.length > 0, 'each failure is logged')

  const malformed = { data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } }
  await withApp({ handlers: { user_grades: () => malformed } }, async ({ call }) => {
    const answer = await call('DELETE', `/api/me/grades/${GRADE_ID}`)
    assert.equal(answer.status, 404)
    assert.deepEqual(answer.body, NOT_FOUND)
  })
})
