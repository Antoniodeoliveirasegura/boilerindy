import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import {
  DB_FEATURES,
  badRequest,
  isSchemaMissingError,
  logRouteError,
  respondDbError,
  respondRouteError,
  respondSchemaMissing,
} from '../src/dbErrors.mjs'

// Issue #218: a missing table used to answer 503 with Supabase SQL Editor
// instructions in the client body and, for most features, no code. Clients key
// off `${feature}_schema_missing`; the operator instruction belongs in the log.

// Minimal Express res double (same style as apiNotFound.test.mjs).
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
}

// Every console.error call, flattened to one string, so a test can assert what
// did (or did not) reach the log and therefore Sentry. Objects are inspected in
// full rather than turned into "[object Object]": Sentry's captureConsole keeps
// the raw arguments, so a logged error object would carry details and hint.
function spyConsoleError(t) {
  const spy = t.mock.method(console, 'error', () => {})
  return {
    get count() {
      return spy.mock.callCount()
    },
    text() {
      return spy.mock.calls
        .map((call) => call.arguments.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 5 }))).join(' '))
        .join('\n')
    },
  }
}

const tableMissing = () => ({
  code: 'PGRST205',
  message: "Could not find the table 'public.guide_recommendations' in the schema cache",
  details: null,
  hint: "Perhaps you meant the table 'public.guide_upvotes'",
})

// Unique violation carrying row values in details and hint: must never be logged.
const uniqueViolation = () => ({
  code: '23505',
  message: 'duplicate key value violates unique constraint "users_purdue_username_key"',
  details: 'Key (purdue_username)=(jdoe) already exists.',
  hint: 'secret-hint-value',
})

test('the codes clients depend on are pinned; board and advertiser keep their existing codes', () => {
  const codes = Object.values(DB_FEATURES).map((config) => `${config.feature}_schema_missing`)
  assert.deepEqual(codes.sort(), [
    'advertiser_schema_missing',
    'board_schema_missing',
    'deals_schema_missing',
    'friends_schema_missing',
    'guide_schema_missing',
    'marketplace_schema_missing',
    'moderation_schema_missing',
    'study_groups_schema_missing',
  ])
})

test('every registry key matches its feature and the config is frozen', () => {
  for (const [key, config] of Object.entries(DB_FEATURES)) {
    assert.equal(config.feature, key)
    assert.match(key, /^[a-z]+(_[a-z]+)*$/)
    assert.ok(Object.isFrozen(config), `${key} config is frozen`)
    for (const file of [].concat(config.sqlFile)) assert.match(file, /^db\/supabase-[a-z-]+\.sql$/)
  }
  assert.ok(Object.isFrozen(DB_FEATURES))
})

test('isSchemaMissingError: PostgREST and Postgres missing-table errors', () => {
  assert.equal(isSchemaMissingError({ code: 'PGRST205', message: 'anything' }), true)
  assert.equal(isSchemaMissingError({ code: '42P01', message: 'relation "public.deals" does not exist' }), true)
  // Same errors without a code, and a missing column or function.
  assert.equal(isSchemaMissingError({ message: "Could not find the table 'public.deals' in the schema cache" }), true)
  assert.equal(isSchemaMissingError({ message: 'relation "public.study_groups" does not exist' }), true)
  assert.equal(isSchemaMissingError({ code: '42703', message: 'column deals.deleted_at does not exist' }), true)
  assert.equal(
    isSchemaMissingError({ code: 'PGRST204', message: "Could not find the 'edited_at' column of 'board_posts' in the schema cache" }),
    true,
  )
})

test('isSchemaMissingError: a missing function, operator or type is a query bug, not a migration', () => {
  // These also say "does not exist", but no table or column is missing, so they
  // keep the 500 path, which logs every time, instead of a "coming soon" 503.
  assert.equal(isSchemaMissingError({ code: '42883', message: 'operator does not exist: uuid = text' }), false)
  assert.equal(isSchemaMissingError({ code: '42883', message: 'function gen_random_uuid() does not exist' }), false)
  assert.equal(isSchemaMissingError({ code: '42704', message: 'type "listing_status" does not exist' }), false)
  assert.equal(isSchemaMissingError({ message: 'operator does not exist: uuid = text' }), false)
  assert.equal(isSchemaMissingError({ message: 'function public.bump_views(uuid) does not exist' }), false)
  // A code that is not a schema code wins over a message that looks like one.
  assert.equal(isSchemaMissingError({ code: '42883', message: 'function f(column text) does not exist' }), false)
  // PostgREST's missing-function error also says "schema cache"; the code wins.
  assert.equal(
    isSchemaMissingError({
      code: 'PGRST202',
      message: 'Could not find the function public.sync_board_post_upvote_count(p_post_id) in the schema cache',
    }),
    false,
  )
})

test('a missing function answers 500 with the fallback, not a schema_missing 503', (t) => {
  const log = spyConsoleError(t)
  const res = mockRes()
  respondDbError(res, { code: 'PGRST202', message: 'Could not find the function public.f(a) in the schema cache' }, DB_FEATURES.guide)
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { error: { message: 'Could not load the guide. Please try again.', status: 500 } })
  assert.match(log.text(), /^guide DB error: PGRST202 Could not find the function/)
})

test('isSchemaMissingError: other errors and non-errors are not schema-missing', () => {
  assert.equal(isSchemaMissingError(uniqueViolation()), false)
  assert.equal(isSchemaMissingError({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }), false)
  assert.equal(isSchemaMissingError(new Error('fetch failed')), false)
  assert.equal(isSchemaMissingError(null), false)
  assert.equal(isSchemaMissingError(undefined), false)
  assert.equal(isSchemaMissingError('PGRST205'), false)
})

test('every feature answers a missing table with 503 and its code, with no operator instructions', (t) => {
  spyConsoleError(t)
  for (const [key, config] of Object.entries(DB_FEATURES)) {
    const res = mockRes()
    respondDbError(res, tableMissing(), config)
    assert.equal(res.statusCode, 503, key)
    assert.deepEqual(res.body, {
      error: {
        message: `${config.label} is not set up yet. Please try again later.`,
        code: `${key}_schema_missing`,
        status: 503,
      },
    })
    const message = res.body.error.message
    assert.doesNotMatch(message, /SQL Editor|\.sql|Supabase/, `${key} message stays client-safe`)
  }
})

test('the operator instruction is logged once per feature, SQL file and database error, never sent to the client', (t) => {
  const log = spyConsoleError(t)
  const config = { feature: 'log_once', label: 'Log once', sqlFile: 'db/supabase-log-once.sql', fallback: 'Nope.' }

  const first = mockRes()
  respondDbError(first, tableMissing(), config)
  assert.equal(log.count, 1)
  assert.match(log.text(), /\[log_once\] schema missing: run db\/supabase-log-once\.sql in the Supabase SQL Editor/)
  assert.match(log.text(), /PGRST205/)
  assert.doesNotMatch(JSON.stringify(first.body), /supabase-log-once|SQL Editor/)

  respondDbError(mockRes(), tableMissing(), config)
  respondSchemaMissing(mockRes(), config, tableMissing())
  assert.equal(log.count, 1, 'repeat hits stay out of the log (and Sentry)')

  // Same feature, different migration: that instruction is new, so it logs.
  respondSchemaMissing(mockRes(), { ...config, sqlFile: 'db/supabase-log-once-extra.sql' })
  assert.equal(log.count, 2)
  assert.match(log.text(), /run db\/supabase-log-once-extra\.sql in/)
})

test('a new error code for the same feature logs once too, so a new cause is never silent', (t) => {
  const log = spyConsoleError(t)
  const config = { feature: 'per_code', label: 'Per code', sqlFile: 'db/supabase-per-code.sql', fallback: 'Nope.' }

  respondDbError(mockRes(), tableMissing(), config)
  respondDbError(mockRes(), tableMissing(), config)
  assert.equal(log.count, 1)

  // The table is back but a column from a later migration is not.
  const columnMissing = { code: '42703', message: 'column per_code.edited_at does not exist' }
  respondDbError(mockRes(), columnMissing, config)
  assert.equal(log.count, 2)
  assert.match(log.text(), /42703 column per_code\.edited_at does not exist/)
  respondDbError(mockRes(), columnMissing, config)
  assert.equal(log.count, 2, 'the same column stays logged once')
})

test('a second missing column with the same code logs its own line', (t) => {
  const log = spyConsoleError(t)
  const config = { feature: 'per_column', label: 'Per column', sqlFile: 'db/supabase-per-column.sql', fallback: 'Nope.' }

  respondDbError(mockRes(), { code: '42703', message: 'column per_column.deleted_at does not exist' }, config)
  respondDbError(mockRes(), { code: '42703', message: 'column per_column.deleted_at does not exist' }, config)
  assert.equal(log.count, 1)

  // The operator fixed deleted_at without a restart; the next missing column
  // must not be silent while clients keep getting 503.
  respondDbError(mockRes(), { code: '42703', message: 'column per_column.hidden does not exist' }, config)
  assert.equal(log.count, 2)
  assert.match(log.text(), /42703 column per_column\.hidden does not exist/)
  respondDbError(mockRes(), { code: '42703', message: 'column per_column.hidden does not exist' }, config)
  assert.equal(log.count, 2)
})

test('a feature with several SQL files names all of them in the log', (t) => {
  const log = spyConsoleError(t)
  const config = { feature: 'two_files', label: 'Two files', sqlFile: ['db/supabase-a.sql', 'db/supabase-b.sql'], fallback: 'x' }
  respondSchemaMissing(mockRes(), config, tableMissing())
  assert.match(log.text(), /run db\/supabase-a\.sql and db\/supabase-b\.sql in the Supabase SQL Editor/)
})

test('an override keeps the feature code but changes the message subject', (t) => {
  spyConsoleError(t)
  const res = mockRes()
  const config = { ...DB_FEATURES.study_groups, label: 'Removing study groups', sqlFile: 'db/supabase-study-groups-soft-delete.sql' }
  respondSchemaMissing(res, config, { code: '42703', message: 'column study_groups.deleted_at does not exist' })
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.body, {
    error: {
      message: 'Removing study groups is not set up yet. Please try again later.',
      code: 'study_groups_schema_missing',
      status: 503,
    },
  })
})

test('any other database error answers 500 with the feature fallback and no code', (t) => {
  const log = spyConsoleError(t)
  const res = mockRes()
  respondDbError(res, uniqueViolation(), DB_FEATURES.marketplace)
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { error: { message: 'Could not load the marketplace. Please try again.', status: 500 } })
  assert.equal(log.count, 1)
  assert.match(log.text(), /^marketplace DB error: 23505 duplicate key value violates unique constraint/)
})

test('details and hint never reach console.error', (t) => {
  const log = spyConsoleError(t)
  respondDbError(mockRes(), uniqueViolation(), DB_FEATURES.board)
  respondDbError(mockRes(), { ...tableMissing(), details: 'Key (email)=(a@b.c)' }, {
    feature: 'details_check',
    label: 'Details check',
    sqlFile: 'db/supabase-details-check.sql',
    fallback: 'x',
  })
  assert.equal(log.count, 2)
  const text = log.text()
  assert.doesNotMatch(text, /jdoe|Key \(|secret-hint-value|Perhaps you meant|a@b\.c/)
})

test('a thrown non-object is logged as its string form and answers 500', (t) => {
  const log = spyConsoleError(t)
  const res = mockRes()
  respondDbError(res, 'socket hang up', DB_FEATURES.friends)
  assert.equal(res.statusCode, 500)
  assert.equal(res.body.error.message, 'Could not load matches. Please try again.')
  assert.match(log.text(), /friends DB error: null socket hang up/)
})

// ---- Routes outside DB_FEATURES (issue #206) --------------------------------
//
// Tasks, grades and dining favorites answered 500 with the PostgREST message and
// no status, and logged the whole error object. respondRouteError keeps the
// database text in the log (code and message only) and sends a fallback.

test('badRequest answers 400 in the standard envelope', () => {
  const res = mockRes()
  const returned = badRequest(res, 'An item name is required')
  assert.equal(returned, res, 'returns the response so a handler can `return badRequest(...)`')
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.body, { error: { message: 'An item name is required', status: 400 } })
})

test('respondRouteError answers 500 with the fallback and logs code and message under the label', (t) => {
  const log = spyConsoleError(t)
  const res = mockRes()
  const notNull = {
    code: '23502',
    message: 'null value in column "due_at" of relation "user_manual_tasks" violates not-null constraint',
    details: 'Failing row contains (5d1c, jdoe-private-title, null).',
    hint: null,
  }
  respondRouteError(res, notNull, { label: 'POST /api/me/tasks/manual', fallback: 'Could not create task' })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { error: { message: 'Could not create task', status: 500 } })
  assert.equal(log.count, 1)
  assert.match(log.text(), /^POST \/api\/me\/tasks\/manual: 23502 null value in column "due_at"/)
  assert.doesNotMatch(log.text(), /Failing row|jdoe-private-title/)
})

test('respondRouteError never sends the database text, details or hint to the client', (t) => {
  const log = spyConsoleError(t)
  const res = mockRes()
  respondRouteError(res, uniqueViolation(), { label: 'POST /api/me/dining/favorites', fallback: 'Could not save favorite' })
  const body = JSON.stringify(res.body)
  assert.doesNotMatch(body, /duplicate key|users_purdue_username_key|jdoe|secret-hint-value/)
  assert.doesNotMatch(log.text(), /jdoe|Key \(|secret-hint-value/)
})

test('respondRouteError answers a missing row or a malformed id with 404 and no log line', (t) => {
  const log = spyConsoleError(t)
  for (const err of [
    { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object', details: 'The result contains 0 rows' },
    { code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' },
  ]) {
    const res = mockRes()
    respondRouteError(res, err, { label: 'PATCH /api/me/grades/:id', fallback: 'Could not update course' })
    assert.equal(res.statusCode, 404, err.code)
    assert.deepEqual(res.body, { error: { message: 'Not found.', status: 404 } })
  }
  assert.equal(log.count, 0, 'an expected 404 stays out of the log (and Sentry)')
})

test('respondRouteError handles thrown non-database values and missing options', (t) => {
  const log = spyConsoleError(t)

  const typeError = mockRes()
  respondRouteError(typeError, new TypeError("Cannot read properties of undefined (reading 'email')"), {
    label: 'POST /api/auth/register-supabase',
    fallback: 'Could not create account.',
  })
  assert.equal(typeError.statusCode, 500)
  assert.deepEqual(typeError.body, { error: { message: 'Could not create account.', status: 500 } })

  const thrownString = mockRes()
  respondRouteError(thrownString, 'socket hang up')
  assert.equal(thrownString.statusCode, 500)
  assert.deepEqual(thrownString.body, { error: { message: 'Something went wrong. Please try again.', status: 500 } })

  // A code that only looks like a not-found code as a string is not one.
  respondRouteError(mockRes(), 'PGRST116', { label: 'x', fallback: 'y' })

  assert.equal(log.count, 3)
  const lines = log.text().split('\n')
  assert.match(lines[0], /^POST \/api\/auth\/register-supabase: null Cannot read properties of undefined/)
  assert.equal(lines[1], 'Route error: null socket hang up')
  assert.equal(lines[2], 'x: null PGRST116')
})

test('logRouteError logs the label, code and message only', (t) => {
  const log = spyConsoleError(t)
  logRouteError('register-supabase: public.users insert failed', {
    code: '23505',
    message: 'duplicate key value violates unique constraint "users_email_key"',
    details: 'Key (email)=(student@purdue.edu) already exists.',
    hint: 'secret-hint-value',
  })
  assert.equal(log.count, 1)
  assert.equal(
    log.text(),
    'register-supabase: public.users insert failed: 23505 duplicate key value violates unique constraint "users_email_key"',
  )
})
