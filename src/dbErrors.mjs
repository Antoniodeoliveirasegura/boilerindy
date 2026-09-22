// Shared database error responders for the API (issue #218).
//
// Before this module every feature in server.mjs had its own respond*DbError
// helper, and most of them answered a missing table with a 503 whose message
// told the reader to open the Supabase SQL Editor, with no machine-readable
// code. The mobile app maps 503 plus a code ending in `_schema_missing` to a
// "coming soon" state, so those features showed a hard error full of operator
// instructions instead. Now the client gets a short message and a code, and the
// operator instruction goes to the server log once.
//
// Exports:
//   DB_FEATURES                   one config per feature: { feature, label, sqlFile, fallback }.
//                                 The 503 code is `${feature}_schema_missing`; add a feature
//                                 here (and to docs/api-error-codes.md) rather than inline.
//   isSchemaMissingError(err)     true when Supabase reports a table or column that does not
//                                 exist yet, i.e. a migration has not run. A missing function
//                                 (PGRST202, 42883), operator or type is a query bug and
//                                 answers false.
//   respondSchemaMissing(res, config, err?)
//                                 503 { error: { message, code, status } } for a feature that
//                                 is not set up; logs the SQL file to run once per process
//                                 for each feature, file and database error (code and message).
//   respondDbError(res, err, config)
//                                 respondSchemaMissing for a schema-missing error, otherwise
//                                 logs code and message and answers 500 with config.fallback.
//   badRequest(res, message)      400 { error: { message, status: 400 } } (issue #206).
//   respondRouteError(res, err, { label, fallback })
//                                 for routes with no DB_FEATURES entry (tasks, grades, dining
//                                 favorites, account routes): a missing row or a malformed id
//                                 (PGRST116, 22P02) answers 404 without a log line; anything
//                                 else logs `${label}:` code and message and answers 500 with
//                                 fallback, never the database text (issue #206).
//   logRouteError(label, err)     that log line alone, for a route that answers on its own.
//
// Every answer from this module uses the standard envelope
// { error: { message, status, code? } } documented in docs/api-error-codes.md.
// Logs carry the error's code and message only, never `details` or `hint`:
// console.error is forwarded to Sentry (captureConsoleIntegration) and a
// Postgres detail can hold row values.

/**
 * @typedef {object} DbFeature
 * @property {string} feature  snake_case key; the 503 code is `${feature}_schema_missing`
 * @property {string} label    subject of the client message: `${label} is not set up yet.`
 * @property {string | string[]} sqlFile  migration(s) the operator runs, named only in the log
 * @property {string} fallback client message for any other database error (500)
 */

/**
 * @param {string} feature
 * @param {string} label
 * @param {string | string[]} sqlFile
 * @param {string} fallback
 * @returns {Readonly<DbFeature>}
 */
function dbFeature(feature, label, sqlFile, fallback) {
  return Object.freeze({ feature, label, sqlFile, fallback })
}

/** @type {Readonly<Record<string, Readonly<DbFeature>>>} */
export const DB_FEATURES = Object.freeze({
  board: dbFeature(
    'board',
    'The campus board',
    'db/supabase-board-only.sql',
    'Something went wrong. Please try again.',
  ),
  guide: dbFeature(
    'guide',
    'The Neighborhood Guide',
    'db/supabase-neighborhood-guide.sql',
    'Could not load the guide. Please try again.',
  ),
  study_groups: dbFeature(
    'study_groups',
    'The Study Group Finder',
    'db/supabase-study-groups.sql',
    'Could not load study groups. Please try again.',
  ),
  deals: dbFeature(
    'deals',
    'Campus Perks',
    'db/supabase-campus-deals.sql',
    'Could not load deals. Please try again.',
  ),
  marketplace: dbFeature(
    'marketplace',
    'The marketplace',
    'db/supabase-marketplace.sql',
    'Could not load the marketplace. Please try again.',
  ),
  friends: dbFeature(
    'friends',
    'Friend matching',
    'db/supabase-friend-matching.sql',
    'Could not load matches. Please try again.',
  ),
  advertiser: dbFeature(
    'advertiser',
    'The advertiser portal',
    ['db/supabase-advertiser-portal.sql', 'db/supabase-advertiser-campaigns.sql'],
    'Something went wrong. Please try again.',
  ),
  // Admin soft-delete moderation. server.mjs overrides label and sqlFile per
  // content type, since each table's deleted_at column comes from its own file.
  moderation: dbFeature(
    'moderation',
    'Moderation',
    'db/supabase-soft-delete.sql',
    'Something went wrong. Please try again.',
  ),
})

// A missing table or column: what an unrun CREATE TABLE or ADD COLUMN migration
// produces. PGRST205 and 42P01 are tables, 42703 and PGRST204 columns (the same
// pair src/moderation.mjs isMissingColumnError uses).
const SCHEMA_MISSING_CODES = new Set(['PGRST205', '42P01', '42703', 'PGRST204'])
// Errors that also say "does not exist" or "schema cache" but come from the
// query, not a missing table or column: Postgres 42883 undefined function or
// operator ("operator does not exist: uuid = text"), 42704 undefined object such
// as a type, and PostgREST PGRST202 ("Could not find the function ... in the
// schema cache"). They stay 500s.
const QUERY_BUG_CODES = new Set(['42883', '42704', 'PGRST202'])
const MISSING_RELATION_OR_COLUMN = /\b(?:relation|column) .+ does not exist/

/**
 * True when Supabase reports a table or column that does not exist yet, i.e. a
 * migration has not run: PostgREST PGRST205 ("Could not find the table ... in
 * the schema cache") or PGRST204 (a column missing from the schema cache), and
 * Postgres 42P01 ("relation ... does not exist") or 42703 ("column ... does not
 * exist"). Without one of those codes, the message decides: "schema cache",
 * "Could not find the table", or a relation or column that "does not exist".
 * A missing function, operator or type (42883, 42704, PGRST202) is a query bug
 * and is never schema-missing, so it keeps the 500 path that logs every time.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isSchemaMissingError(err) {
  if (!err || typeof err !== 'object') return false
  const code = String(err.code || '')
  if (SCHEMA_MISSING_CODES.has(code)) return true
  if (QUERY_BUG_CODES.has(code)) return false
  const message = String(err.message || '')
  return (
    message.includes('schema cache') ||
    message.includes('Could not find the table') ||
    MISSING_RELATION_OR_COLUMN.test(message)
  )
}

// Code and message only; a thrown non-object becomes its string form.
function errorFields(err) {
  if (err && typeof err === 'object') {
    return { code: err.code ?? null, message: err.message ?? null }
  }
  return { code: null, message: err == null ? null : String(err) }
}

// Operator instructions already logged, keyed by feature, SQL file(s), error
// code and message, so a missing table hit on every request logs (and reaches
// Sentry) once per process, while a different cause for the same feature (a
// missing column after the table exists, or a second missing column) still logs
// its own line once. A schema-missing message names only a table or column, so
// the schema bounds the keys; the cap is a backstop that starts the log-once
// window over rather than growing without limit.
const loggedSchemaMissing = new Set()
const LOGGED_SCHEMA_MISSING_MAX = 200

function logSchemaMissingOnce(config, err) {
  const files = [].concat(config.sqlFile).join(' and ')
  const { code, message } = errorFields(err)
  const key = `${config.feature}|${files}|${code ?? ''}|${message ?? ''}`
  if (loggedSchemaMissing.has(key)) return
  if (loggedSchemaMissing.size >= LOGGED_SCHEMA_MISSING_MAX) loggedSchemaMissing.clear()
  loggedSchemaMissing.add(key)
  console.error(
    `[${config.feature}] schema missing: run ${files} in the Supabase SQL Editor, then retry.`,
    code,
    message,
  )
}

/**
 * Answer 503 for a feature whose tables (or columns) are not in the database
 * yet. The client sees a short message and `${feature}_schema_missing`; the SQL
 * file to run is logged once per feature, file and database error, never sent.
 * @param {{ status: (code: number) => any }} res Express response
 * @param {DbFeature} config
 * @param {unknown} [err] the database error, for the one-time log line
 */
export function respondSchemaMissing(res, config, err) {
  logSchemaMissingOnce(config, err)
  return res.status(503).json({
    error: {
      message: `${config.label} is not set up yet. Please try again later.`,
      code: `${config.feature}_schema_missing`,
      status: 503,
    },
  })
}

/**
 * Answer a failed database call: 503 with `${feature}_schema_missing` when a
 * migration has not run, otherwise log the code and message and answer 500
 * with the feature's fallback message.
 * @param {{ status: (code: number) => any }} res Express response
 * @param {unknown} err
 * @param {DbFeature} config
 */
export function respondDbError(res, err, config) {
  if (isSchemaMissingError(err)) return respondSchemaMissing(res, config, err)
  const { code, message } = errorFields(err)
  console.error(`${config.feature} DB error:`, code, message)
  return res.status(500).json({ error: { message: config.fallback, status: 500 } })
}

// ---- Routes outside DB_FEATURES (issue #206) --------------------------------
//
// The per-user tasks, grades and dining favorites routes used to answer
// `500 { error: { message: e.message } }`, which put the PostgREST text
// (constraint names, "invalid input syntax for type uuid: ...") in front of the
// student, and logged the whole error object, details and hint included.

// PostgREST PGRST116: `.single()` found no row (or several). Postgres 22P02:
// invalid text for the column type, such as a malformed uuid in an :id param.
// Either way the row the client named is not there (issue #196), and a probe
// learns nothing more than "not found".
const NOT_FOUND_CODES = new Set(['PGRST116', '22P02'])

/**
 * Answer 400 in the standard envelope.
 * @param {{ status: (code: number) => any }} res Express response
 * @param {string} message client-safe text
 */
export function badRequest(res, message) {
  return res.status(400).json({ error: { message, status: 400 } })
}

/**
 * Log a failed call as `${label}:` followed by the error's code and message.
 * Never the whole object: console.error reaches Sentry, and `details` or
 * `hint` can hold row values ("Key (purdue_username)=(jdoe) already exists.").
 * @param {string} label route or operation, e.g. 'POST /api/me/grades'
 * @param {unknown} err
 */
export function logRouteError(label, err) {
  const { code, message } = errorFields(err)
  // Literal format string: a label built from a request value would otherwise
  // sit in console.error's format slot, where a `%s` in it swallows the next
  // argument (CodeQL js/tainted-format-string, see #322).
  console.error('%s:', label, code, message)
}

/**
 * Answer a failed route that has no DB_FEATURES entry. A missing row or a
 * malformed id answers 404 `Not found.` without logging; any other error is
 * logged with logRouteError and answers 500 with `fallback`. The database
 * message never reaches the client.
 * @param {{ status: (code: number) => any }} res Express response
 * @param {unknown} err
 * @param {{ label: string, fallback?: string }} options label starts the log line;
 *   fallback is the client message for a 500
 */
export function respondRouteError(res, err, { label = 'Route error', fallback = 'Something went wrong. Please try again.' } = {}) {
  if (err && typeof err === 'object' && NOT_FOUND_CODES.has(String(err.code))) {
    return res.status(404).json({ error: { message: 'Not found.', status: 404 } })
  }
  logRouteError(label, err)
  return res.status(500).json({ error: { message: fallback, status: 500 } })
}
