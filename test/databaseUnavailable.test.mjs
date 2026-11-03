import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DATABASE_UNAVAILABLE,
  createDatabaseOutageLog,
  describeDatabaseFailure,
  isDatabaseUnavailableError,
  respondDatabaseUnavailable,
} from '../src/databaseUnavailable.mjs'
import { SupabaseQueryError } from '../src/cronTick.mjs'
import { UpstreamError } from '../src/upstreamFetch.mjs'

// The 2026-11-03 outage: the shapes supabase-js handed the server while the
// database could not be reached, and the ones that must still read as bugs.

// What postgrest-js returns for a gateway's non-JSON body: { message: body }.
// Trimmed from the page Cloudflare served that day; the title is the part that
// matters.
function cloudflarePage(status, text) {
  return {
    message: [
      '<!DOCTYPE html>',
      '<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->',
      '<head>',
      `<title>supabase.co | ${status}: ${text}</title>`,
      '</head>',
      `<body><span class="code-label">Error code ${status}</span>`,
      '<p>The initial connection between Cloudflare\'s network and the origin web server timed out.</p></body>',
    ].join('\n'),
  }
}

// What PostgREST answered while the restart came up.
const schemaCacheLoading = () => ({
  code: 'PGRST002',
  message: 'Could not query the database for the schema cache. Retrying.',
  details: null,
  hint: null,
})

// What postgrest-js builds when the fetch itself fails.
const fetchFailed = () => ({
  message: 'TypeError: fetch failed',
  details: 'TypeError: fetch failed\n\nCaused by: ConnectTimeoutError: Connect Timeout Error',
  hint: '',
  code: '',
})

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(name, value) {
      this.headers[name] = value
      return this
    },
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

test('the outage shapes of 2026-11-03 all read as database unavailable', () => {
  assert.equal(isDatabaseUnavailableError(cloudflarePage(522, 'Connection timed out')), true)
  assert.equal(isDatabaseUnavailableError(cloudflarePage(521, 'Web server is down')), true)
  assert.equal(isDatabaseUnavailableError(cloudflarePage(525, 'SSL handshake failed')), true)
  assert.equal(isDatabaseUnavailableError({ message: 'upstream request timeout' }), true)
  assert.equal(isDatabaseUnavailableError(schemaCacheLoading()), true)
})

test('connection codes, a failed fetch and a gateway status on a SupabaseQueryError are unavailable too', () => {
  for (const code of ['PGRST000', 'PGRST001', 'PGRST003', '53300', '08006', '57P01', '57P03']) {
    assert.equal(isDatabaseUnavailableError({ code, message: 'x', details: null, hint: null }), true, code)
  }
  assert.equal(isDatabaseUnavailableError(fetchFailed()), true)
  assert.equal(isDatabaseUnavailableError({ message: 'x', details: '', hint: '', code: 'ECONNRESET' }), true)
  assert.equal(isDatabaseUnavailableError(new SupabaseQueryError('linked_sources select', { message: 'Gateway Timeout' }, 504)), true)
  assert.equal(isDatabaseUnavailableError(new SupabaseQueryError('linked_sources select', { message: 'fetch failed' }, 0)), true)
})

test('a failed query, another service and anything else are not', () => {
  const notOutages = [
    { code: 'PGRST205', message: "Could not find the table 'public.board_posts' in the schema cache", details: null, hint: null },
    { code: 'PGRST202', message: 'Could not find the function public.f(a) in the schema cache', details: null, hint: null },
    { code: '23505', message: 'duplicate key value violates unique constraint', details: 'Key (id)=(1)', hint: null },
    { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null },
    new SupabaseQueryError('push_settings select', { message: 'permission denied', code: '42501' }, 401),
    new UpstreamError('TransLoc', 'timeout'),
    new UpstreamError('TransLoc', 'status', { status: 522 }),
    // Not a Supabase call: a bare fetch failure or another host's error page.
    new Error('fetch failed'),
    { message: '<title>example.com | 522: Connection timed out</title>' },
    null,
    undefined,
    'PGRST002',
  ]
  for (const err of notOutages) assert.equal(isDatabaseUnavailableError(err), false, String(err?.message ?? err))
})

test('describeDatabaseFailure is short and never the page itself', () => {
  assert.equal(describeDatabaseFailure(cloudflarePage(522, 'Connection timed out')), 'Supabase 522 Connection timed out')
  assert.equal(describeDatabaseFailure(cloudflarePage(521, 'Web server is down')), 'Supabase 521 Web server is down')
  assert.equal(describeDatabaseFailure({ message: 'upstream request timeout' }), 'Supabase gateway upstream request timeout')
  assert.equal(describeDatabaseFailure(schemaCacheLoading()), 'Supabase PGRST002')
  assert.equal(describeDatabaseFailure(new SupabaseQueryError('x', { message: 'Gateway Timeout' }, 504)), 'Supabase 504')
  assert.equal(describeDatabaseFailure(fetchFailed()), 'Supabase unreachable')
  assert.equal(describeDatabaseFailure({ message: 'x', details: '', hint: '', code: 'ECONNRESET' }), 'Supabase unreachable (ECONNRESET)')
})

test('the outage log writes one line a minute, counting the requests since the line before', () => {
  let clock = 0
  const lines = []
  const note = createDatabaseOutageLog({ log: { warn: (line) => lines.push(line) }, now: () => clock })
  note(cloudflarePage(522, 'Connection timed out'), 'GET /api/me')
  clock = 20_000
  note(cloudflarePage(522, 'Connection timed out'), 'GET /api/me')
  note(cloudflarePage(522, 'Connection timed out'), 'GET /api/session')
  assert.equal(lines.length, 1)
  clock = 61_000
  note(schemaCacheLoading(), 'campus_events')
  assert.deepEqual(lines, [
    '[database] unavailable (Supabase 522 Connection timed out) at GET /api/me: 1 request(s) answered 503 database_unavailable since the previous line',
    '[database] unavailable (Supabase PGRST002) at campus_events: 3 request(s) answered 503 database_unavailable since the previous line',
  ])
})

test('the reporter hears of an outage at once, then at most every 15 minutes', () => {
  let clock = 0
  const reports = []
  const note = createDatabaseOutageLog({ log: { warn() {} }, report: (summary) => reports.push(summary), now: () => clock })
  for (clock = 0; clock <= 30 * 60_000; clock += 60_000) note(schemaCacheLoading(), 'GET /api/me')
  assert.deepEqual(
    reports.map((r) => r.failedRequests),
    [1, 1, 1],
  )
  assert.deepEqual(reports[0], { what: 'Supabase PGRST002', where: 'GET /api/me', failedRequests: 1 })
})

test('a reporter that throws does not break the answer', () => {
  const note = createDatabaseOutageLog({
    log: { warn() {} },
    report: () => {
      throw new Error('Sentry is down too')
    },
  })
  const res = mockRes()
  respondDatabaseUnavailable(res, schemaCacheLoading(), { note })
  assert.equal(res.statusCode, 503)
})

test('respondDatabaseUnavailable answers 503 database_unavailable with a Retry-After and notes where', () => {
  const noted = []
  const res = mockRes()
  respondDatabaseUnavailable(res, cloudflarePage(522, 'Connection timed out'), { where: 'campus_events', note: (err, where) => noted.push(where) })
  assert.equal(res.statusCode, 503)
  assert.equal(res.headers['Retry-After'], '30')
  assert.deepEqual(res.body, {
    error: { message: DATABASE_UNAVAILABLE.message, code: 'database_unavailable', status: 503 },
  })
  assert.doesNotMatch(JSON.stringify(res.body), /DOCTYPE|supabase\.co|Cloudflare/)
  assert.deepEqual(noted, ['campus_events'])
})
