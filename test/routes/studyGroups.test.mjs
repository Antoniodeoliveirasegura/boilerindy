import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createStudyGroupsRouter } from '../../src/routes/studyGroups.mjs'
import { BOARD_PROFANITY_USER_MESSAGE } from '../../src/boardProfanity.mjs'
import { fakeSupabase, hasCall, operation } from './fakeSupabase.mjs'

// Issue #191: the Study Group Finder routes as a feature router, booted on a
// small app with a fake session, recording limiters, a recording database and
// a fake of the class-items reader server.mjs injects.

const STUDENT = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.com', study_groups_opt_in: true }
const OTHER = '22222222-2222-4222-8222-222222222222'
const ADMIN = { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.com', is_admin: true }
const GROUP_ID = '88888888-8888-4888-8888-888888888888'
const GROUP_2 = '99999999-9999-4999-8999-999999999999'

function groupRow(overrides = {}) {
  return {
    id: GROUP_ID,
    course_code: 'CS 18000',
    title: 'Midterm prep',
    description: 'Past exams',
    meeting_info: 'Library, 2nd floor',
    capacity: 4,
    creator_id: STUDENT.id,
    created_at: '2026-09-15T18:00:00.000Z',
    ...overrides,
  }
}

const CLASS_ITEMS = [{ title: 'CS 18000 Lecture' }, { title: 'MA 16500 Recitation' }, { title: 'cs18000 lab' }, { title: 'Lunch' }]
const isUserAdmin = (user) => user?.is_admin === true

async function withApp({ user = STUDENT, handlers = {}, classItems = CLASS_ITEMS } = {}, run) {
  const supabase = fakeSupabase({
    users: () => ({ data: null, error: null }),
    study_groups: () => ({ data: [], error: null }),
    study_group_members: () => ({ data: [], error: null }),
    study_group_courses: () => ({ data: [], error: null }),
    ...handlers,
  })
  const limiterHits = []
  const classItemCalls = []
  const limiter = (name) => (req, _res, next) => {
    limiterHits.push(`${name} ${req.method} ${req.path}`)
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(
    createStudyGroupsRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      isUserAdmin,
      getClassItemsForUser: async (userId, options) => {
        classItemCalls.push({ userId, options })
        return { items: classItems }
      },
      boardWriteRateLimit: limiter('boardWriteRateLimit'),
      userWriteRateLimit: limiter('userWriteRateLimit'),
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
    await run({ call, supabase, limiterHits, classItemCalls })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const NEW_GROUP = { courseCode: 'cs18000', title: 'Midterm prep', description: 'Past exams', meetingInfo: 'Library, 2nd floor', capacity: 4 }

const ROUTES = [
  ['GET', '/api/me/study-groups/courses'],
  ['PATCH', '/api/me/study-groups/opt-in'],
  ['GET', '/api/me/study-groups'],
  ['GET', '/api/study-groups?course=CS%2018000'],
  ['POST', '/api/study-groups'],
  ['POST', `/api/study-groups/${GROUP_ID}/join`],
  ['POST', `/api/study-groups/${GROUP_ID}/leave`],
  ['DELETE', `/api/study-groups/${GROUP_ID}`],
]

test('every route sits behind requireAuth', async () => {
  await withApp({ user: null }, async ({ call, supabase, classItemCalls }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path, method === 'PATCH' || path === '/api/study-groups' ? NEW_GROUP : undefined)
      assert.equal(answer.status, 401, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'You must sign in to access this resource.', status: 401 } })
    }
    assert.equal(supabase.queries.length + supabase.rpcCalls.length, 0)
    assert.equal(classItemCalls.length, 0)
  })
})

test('the writes pass their limiters: user-write for opt-in and delete, board-write for create, join and leave', async () => {
  const handlers = {
    study_groups: (chain) => {
      const op = operation(chain)
      if (op === 'insert') return { data: groupRow(), error: null }
      if (op === 'update') return { data: [{ id: GROUP_ID }], error: null }
      return { data: hasCall(chain, 'maybeSingle') ? { id: GROUP_ID, capacity: 4 } : [], error: null }
    },
    rpc: () => ({ data: { status: 'joined', member_count: 2 }, error: null }),
  }
  await withApp({ handlers }, async ({ call, limiterHits }) => {
    for (const [method, path] of ROUTES) {
      const answer = await call(method, path, method === 'PATCH' || path === '/api/study-groups' ? NEW_GROUP : undefined)
      assert.ok(answer.status < 300, `${method} ${path} answered ${answer.status}`)
    }
    assert.deepEqual(limiterHits, [
      'userWriteRateLimit PATCH /api/me/study-groups/opt-in',
      'boardWriteRateLimit POST /api/study-groups',
      `boardWriteRateLimit POST /api/study-groups/${GROUP_ID}/join`,
      `boardWriteRateLimit POST /api/study-groups/${GROUP_ID}/leave`,
      `userWriteRateLimit DELETE /api/study-groups/${GROUP_ID}`,
    ])
  })
})

test('courses come from the injected getClassItemsForUser through coursesFromClassItems, classmates never count the caller', async () => {
  const handlers = {
    study_group_courses: () => ({
      data: [
        { course_code: 'CS 18000', user_id: OTHER },
        { course_code: 'CS 18000', user_id: STUDENT.id },
        { course_code: 'MA 16500', user_id: OTHER },
        { course_code: 'MA 16500', user_id: '44444444-4444-4444-8444-444444444444' },
      ],
      error: null,
    }),
  }
  await withApp({ handlers }, async ({ call, supabase, classItemCalls }) => {
    const answer = await call('GET', '/api/me/study-groups/courses')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, {
      optIn: true,
      courses: [
        { code: 'CS 18000', classmateCount: 1 },
        { code: 'MA 16500', classmateCount: 2 },
      ],
    })
    assert.deepEqual(classItemCalls, [{ userId: STUDENT.id, options: { term: 'auto', limit: 200 } }])
    const [{ chain }] = supabase.queriesOf('study_group_courses')
    assert.ok(hasCall(chain, 'in', 'course_code', ['CS 18000', 'MA 16500']))
  })
  await withApp({ user: { ...STUDENT, study_groups_opt_in: false }, classItems: [{ title: 'Lunch' }] }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/study-groups/courses')
    assert.deepEqual(answer.body, { optIn: false, courses: [] })
    assert.equal(supabase.queriesOf('study_group_courses').length, 0, 'no classmate lookup without courses')
  })
})

test('opting in stores the flag and snapshots the course codes; opting out only clears them', async () => {
  await withApp({}, async ({ call, supabase, classItemCalls }) => {
    const answer = await call('PATCH', '/api/me/study-groups/opt-in', { optIn: true })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true, optIn: true })
    const [update] = supabase.queriesOf('users')
    assert.ok(hasCall(update.chain, 'update', { study_groups_opt_in: true }))
    assert.ok(hasCall(update.chain, 'eq', 'id', STUDENT.id))
    const [clear, snapshot] = supabase.queriesOf('study_group_courses')
    assert.equal(operation(clear.chain), 'delete')
    assert.ok(hasCall(clear.chain, 'eq', 'user_id', STUDENT.id))
    assert.ok(
      hasCall(snapshot.chain, 'insert', [
        { user_id: STUDENT.id, course_code: 'CS 18000' },
        { user_id: STUDENT.id, course_code: 'MA 16500' },
      ]),
    )
    assert.equal(classItemCalls.length, 1)
  })
  await withApp({}, async ({ call, supabase, classItemCalls }) => {
    const answer = await call('PATCH', '/api/me/study-groups/opt-in', { optIn: 'no' })
    assert.deepEqual(answer.body, { ok: true, optIn: false })
    assert.deepEqual(supabase.queriesOf('study_group_courses').map((q) => operation(q.chain)), ['delete'])
    assert.equal(classItemCalls.length, 0)
  })
})

test('my groups: none without memberships, otherwise the live groups with member counts', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/study-groups')
    assert.deepEqual(answer.body, { groups: [] })
    assert.equal(supabase.queriesOf('study_groups').length, 0)
  })
  const handlers = {
    study_group_members: (chain) =>
      hasCall(chain, 'select', 'group_id')
        ? { data: [{ group_id: GROUP_ID }, { group_id: GROUP_2 }], error: null }
        : { data: [{ group_id: GROUP_ID, user_id: STUDENT.id }, { group_id: GROUP_ID, user_id: OTHER }, { group_id: GROUP_2, user_id: STUDENT.id }], error: null },
    study_groups: () => ({ data: [groupRow(), groupRow({ id: GROUP_2, creator_id: OTHER, capacity: null })], error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/me/study-groups')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.groups[0], {
      id: GROUP_ID,
      courseCode: 'CS 18000',
      title: 'Midterm prep',
      description: 'Past exams',
      meetingInfo: 'Library, 2nd floor',
      capacity: 4,
      memberCount: 2,
      joinedByMe: true,
      isMine: true,
      createdAt: '2026-09-15T18:00:00.000Z',
    })
    assert.equal(answer.body.groups[1].memberCount, 1)
    assert.equal(answer.body.groups[1].isMine, false)
    const [groups] = supabase.queriesOf('study_groups')
    assert.ok(hasCall(groups.chain, 'in', 'id', [GROUP_ID, GROUP_2]))
    assert.ok(hasCall(groups.chain, 'is', 'deleted_at', null), 'taken-down groups stay out')
  })
})

test('the course list needs a valid code, hides deleted groups and falls back until deleted_at exists', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const bad = await call('GET', '/api/study-groups?course=chemistry')
    assert.equal(bad.status, 400)
    assert.deepEqual(bad.body, { error: { message: 'A valid course code is required.', status: 400 } })
    assert.equal(supabase.queries.length, 0)
  })
  await withApp({ handlers: { study_groups: () => ({ data: [groupRow()], error: null }) } }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/study-groups?course=cs18000')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.courseCode, 'CS 18000')
    assert.equal(answer.body.groups.length, 1)
    const [{ chain }] = supabase.queriesOf('study_groups')
    assert.ok(hasCall(chain, 'eq', 'course_code', 'CS 18000'))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'order', 'created_at', { ascending: false }))
    assert.ok(hasCall(chain, 'limit', 100))
  })
  // Before db/supabase-study-groups-soft-delete.sql the live filter fails with
  // 42703, so selectLiveRows reads again without it.
  const handlers = {
    study_groups: (chain) =>
      hasCall(chain, 'is', 'deleted_at', null)
        ? { data: null, error: { code: '42703', message: 'column study_groups.deleted_at does not exist' } }
        : { data: [groupRow()], error: null },
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('GET', '/api/study-groups?course=CS%2018000')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.groups.length, 1)
    assert.equal(supabase.queriesOf('study_groups').length, 2)
  })
})

test('creating a group validates, runs the profanity policy, inserts it and auto-joins the creator', async () => {
  const handlers = { study_groups: () => ({ data: groupRow(), error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const noCourse = await call('POST', '/api/study-groups', { ...NEW_GROUP, courseCode: 'chemistry' })
    assert.equal(noCourse.status, 400)
    assert.deepEqual(noCourse.body, { error: { message: 'A valid course code (e.g. CS 18000) is required', status: 400 } })
    const badCapacity = await call('POST', '/api/study-groups', { ...NEW_GROUP, capacity: 1 })
    assert.deepEqual(badCapacity.body, { error: { message: 'Capacity must be a whole number between 2 and 100', status: 400 } })
    const profane = await call('POST', '/api/study-groups', { ...NEW_GROUP, description: 'no bitch energy' })
    assert.deepEqual(profane.body, { error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
    assert.equal(supabase.queries.length, 0)

    const created = await call('POST', '/api/study-groups', NEW_GROUP)
    assert.equal(created.status, 201)
    assert.equal(created.body.group.memberCount, 1)
    assert.equal(created.body.group.joinedByMe, true)
    assert.equal(created.body.group.isMine, true)
    const [insert] = supabase.queriesOf('study_groups')
    assert.ok(
      hasCall(insert.chain, 'insert', {
        creator_id: STUDENT.id,
        course_code: 'CS 18000',
        title: 'Midterm prep',
        description: 'Past exams',
        meeting_info: 'Library, 2nd floor',
        capacity: 4,
      }),
    )
    const [member] = supabase.queriesOf('study_group_members')
    const values = member.chain.find((c) => c.method === 'insert').args[0]
    assert.equal(values.group_id, GROUP_ID)
    assert.equal(values.user_id, STUDENT.id)
    assert.ok(!Number.isNaN(Date.parse(values.joined_at)))
  })
})

test('join looks the live group up, goes through the join_study_group rpc and maps the outcome', async () => {
  let outcome = { status: 'joined', member_count: 3 }
  const handlers = {
    study_groups: () => ({ data: { id: GROUP_ID, capacity: 4 }, error: null }),
    rpc: () => ({ data: outcome, error: null }),
  }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const joined = await call('POST', `/api/study-groups/${GROUP_ID}/join`)
    assert.equal(joined.status, 200)
    assert.deepEqual(joined.body, { ok: true, memberCount: 3 })
    assert.deepEqual(supabase.rpcCalls.map(({ name, args }) => ({ name, args })), [
      { name: 'join_study_group', args: { p_group_id: GROUP_ID, p_user_id: STUDENT.id } },
    ])
    const [lookup] = supabase.queriesOf('study_groups')
    assert.ok(hasCall(lookup.chain, 'select', 'id, capacity'))
    assert.ok(hasCall(lookup.chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(lookup.chain, 'maybeSingle'))

    outcome = { status: 'full', member_count: 4 }
    const full = await call('POST', `/api/study-groups/${GROUP_ID}/join`)
    assert.equal(full.status, 409)
    assert.deepEqual(full.body, { error: { message: 'This group is full.', status: 409 } })
  })
  await withApp({ handlers: { study_groups: () => ({ data: null, error: null }) } }, async ({ call, supabase }) => {
    const missing = await call('POST', `/api/study-groups/${GROUP_ID}/join`)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Group not found.', status: 404 } })
    assert.equal(supabase.rpcCalls.length, 0)
  })
})

test('leave removes the caller\'s membership only', async () => {
  await withApp({}, async ({ call, supabase }) => {
    const answer = await call('POST', `/api/study-groups/${GROUP_ID}/leave`)
    assert.deepEqual(answer.body, { ok: true })
    const [{ chain }] = supabase.queriesOf('study_group_members')
    assert.equal(operation(chain), 'delete')
    assert.ok(hasCall(chain, 'eq', 'group_id', GROUP_ID))
    assert.ok(hasCall(chain, 'eq', 'user_id', STUDENT.id))
  })
})

test('delete runs through ownerOrAdminScope on creator_id: the creator is scoped, an admin is not', async () => {
  let rows = [{ id: GROUP_ID }]
  const handlers = { study_groups: () => ({ data: rows, error: null }) }
  await withApp({ handlers }, async ({ call, supabase }) => {
    const answer = await call('DELETE', `/api/study-groups/${GROUP_ID}`)
    assert.equal(answer.status, 204)
    const [{ chain }] = supabase.queriesOf('study_groups')
    assert.deepEqual(Object.keys(chain.find((c) => c.method === 'update').args[0]), ['deleted_at'])
    assert.ok(hasCall(chain, 'eq', 'id', GROUP_ID))
    assert.ok(hasCall(chain, 'is', 'deleted_at', null))
    assert.ok(hasCall(chain, 'eq', 'creator_id', STUDENT.id))
    assert.ok(!hasCall(chain, 'eq', 'user_id'))

    rows = []
    const missing = await call('DELETE', `/api/study-groups/${GROUP_ID}`)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: { message: 'Group not found or not yours.', status: 404 } })
  })
  rows = [{ id: GROUP_ID }]
  await withApp({ user: ADMIN, handlers }, async ({ call, supabase }) => {
    assert.equal((await call('DELETE', `/api/study-groups/${GROUP_ID}`)).status, 204)
    assert.ok(!hasCall(supabase.queriesOf('study_groups')[0].chain, 'eq', 'creator_id'), 'an admin takedown has no creator filter')
  })
})

test('database failures: study_groups_schema_missing naming the soft-delete file for deleted_at, the base file for a table, 500 otherwise', async (t) => {
  const log = t.mock.method(console, 'error', () => {})

  const noColumn = { study_groups: () => ({ data: null, error: { code: '42703', message: 'column study_groups.deleted_at does not exist' } }) }
  await withApp({ handlers: noColumn }, async ({ call }) => {
    const answer = await call('DELETE', `/api/study-groups/${GROUP_ID}`)
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, {
      error: { message: 'Removing study groups is not set up yet. Please try again later.', code: 'study_groups_schema_missing', status: 503 },
    })
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-study-groups-soft-delete\.sql/)

  const noTable = { study_group_members: () => ({ data: null, error: { code: '42P01', message: 'relation "public.study_group_members" does not exist' } }) }
  await withApp({ handlers: noTable }, async ({ call }) => {
    const answer = await call('GET', '/api/me/study-groups')
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, {
      error: { message: 'The Study Group Finder is not set up yet. Please try again later.', code: 'study_groups_schema_missing', status: 503 },
    })
  })
  assert.match(String(log.mock.calls.at(-1).arguments[0]), /run db\/supabase-study-groups\.sql/)

  const broken = { study_groups: () => ({ data: null, error: { code: '23514', message: 'check constraint' } }) }
  await withApp({ handlers: broken }, async ({ call }) => {
    const answer = await call('POST', '/api/study-groups', NEW_GROUP)
    assert.equal(answer.status, 500)
    assert.deepEqual(answer.body, { error: { message: 'Could not load study groups. Please try again.', status: 500 } })
  })
})

test('a malformed :id answers the 404 envelope before any query', async () => {
  await withApp({}, async ({ call, supabase }) => {
    for (const [method, path] of [
      ['POST', '/api/study-groups/not-a-uuid/join'],
      ['POST', '/api/study-groups/not-a-uuid/leave'],
      ['DELETE', '/api/study-groups/not-a-uuid'],
    ]) {
      const answer = await call(method, path)
      assert.equal(answer.status, 404, `${method} ${path}`)
      assert.deepEqual(answer.body, { error: { message: 'Not found.', status: 404 } })
    }
    assert.equal(supabase.queries.length + supabase.rpcCalls.length, 0)
  })
})
