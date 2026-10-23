// The sign-up source report behind scripts/signup-refs.mjs: how many accounts
// each marketing link brought (users.signup_ref, src/signupRef.mjs), in total
// and per campus week, as text or CSV. Counts only: it reads signup_ref and
// created_at from each row and puts out refs, weeks and numbers, never an
// email or a name. Pure, so the numbers are tested without the database.

import { sanitizeSignupRef } from './signupRef.mjs'

const CAMPUS_TIME_ZONE = 'America/Indiana/Indianapolis'

/** What the report calls an account with no ref. */
export const NO_SIGNUP_REF = '(none)'

const campusDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMPUS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * An instant's date on the campus calendar, as YYYY-MM-DD, or null for an
 * unreadable instant.
 * @param {string | number | Date | null | undefined} instant
 * @returns {string | null}
 */
export function campusDayOf(instant) {
  // new Date(null) is 1970, not an unreadable date.
  const time = instant == null ? NaN : new Date(instant).getTime()
  if (!Number.isFinite(time)) return null
  const parts = campusDate.formatToParts(time)
  const part = (type) => parts.find((p) => p.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/**
 * The Monday that starts an instant's week on the campus calendar, as
 * YYYY-MM-DD, or null. Campus time, so a sign-up at 11 PM on a Sunday in
 * Indianapolis counts in that week, not the next.
 * @param {string | number | Date | null | undefined} instant
 * @returns {string | null}
 */
export function campusWeekOf(instant) {
  const day = campusDayOf(instant)
  if (!day) return null
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}

function nextWeek(weekOf) {
  const date = new Date(`${weekOf}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 7)
  return date.toISOString().slice(0, 10)
}

// Most sign-ups first, ties by name, and the untagged count last.
function rankRefs(counts) {
  const untagged = (entry) => Number(entry.ref === NO_SIGNUP_REF)
  return [...counts]
    .map(([ref, signups]) => ({ ref, signups }))
    .sort((a, b) => untagged(a) - untagged(b) || b.signups - a.signups || (a.ref < b.ref ? -1 : 1))
}

/**
 * Sign-up counts from users rows, which need only signup_ref and created_at:
 * the total, the count per ref, and the count per campus week (Monday start)
 * with its refs, listing every week from the first sign-up to the last even
 * when it had none. A stored ref is read through the slug rule, so a value
 * written by hand that breaks it counts as no ref; a row without a readable
 * created_at is left out.
 * @param {Array<{ signup_ref?: string | null, created_at?: string | null } | null>} rows
 * @param {{ since?: string }} [options] a YYYY-MM-DD campus date: only sign-ups on or after it
 * @returns {{
 *   total: number,
 *   byRef: Array<{ ref: string, signups: number }>,
 *   byWeek: Array<{ weekOf: string, signups: number, byRef: Array<{ ref: string, signups: number }> }>,
 * }}
 */
export function countSignups(rows, { since } = {}) {
  const byRef = new Map()
  const weeks = new Map()
  let total = 0
  for (const row of rows) {
    const day = campusDayOf(row?.created_at)
    if (!day || (since && day < since)) continue
    const weekOf = campusWeekOf(row.created_at)
    const ref = sanitizeSignupRef(row.signup_ref) ?? NO_SIGNUP_REF
    total += 1
    byRef.set(ref, (byRef.get(ref) ?? 0) + 1)
    if (!weeks.has(weekOf)) weeks.set(weekOf, new Map())
    const week = weeks.get(weekOf)
    week.set(ref, (week.get(ref) ?? 0) + 1)
  }
  const byWeek = []
  const listed = [...weeks.keys()].sort()
  if (listed.length) {
    const last = listed[listed.length - 1]
    for (let weekOf = listed[0]; weekOf <= last; weekOf = nextWeek(weekOf)) {
      const refs = rankRefs(weeks.get(weekOf) ?? new Map())
      byWeek.push({ weekOf, signups: refs.reduce((sum, r) => sum + r.signups, 0), byRef: refs })
    }
  }
  return { total, byRef: rankRefs(byRef), byWeek }
}

/**
 * The counts as the text the script prints: a line per link, then a line per
 * week with that week's links.
 * @param {ReturnType<typeof countSignups>} counts
 * @param {{ since?: string }} [options]
 * @returns {string}
 */
export function formatSignupReport(counts, { since } = {}) {
  const range = since ? `since ${since}` : 'all time'
  if (!counts.total) return `No sign-ups ${range}.\n`
  const refWidth = Math.max(4, ...counts.byRef.map((r) => r.ref.length))
  const countWidth = Math.max(8, String(counts.total).length)
  const lines = [
    `Sign-ups by link, ${range}: ${counts.total}`,
    `Weeks start Monday, campus time. ${NO_SIGNUP_REF} is a sign-up without a tagged link,`,
    'and every account created before sign-up links were saved.',
    '',
    'By link',
    `  ${'Link'.padEnd(refWidth)}  ${'Sign-ups'.padStart(countWidth)}`,
    ...counts.byRef.map((r) => `  ${r.ref.padEnd(refWidth)}  ${String(r.signups).padStart(countWidth)}`),
    '',
    'By week',
    `  Week of     ${'Sign-ups'.padStart(countWidth)}  By link`,
    ...counts.byWeek.map((w) => {
      const refs = w.byRef.map((r) => `${r.ref} ${r.signups}`).join(', ')
      return `  ${w.weekOf}  ${String(w.signups).padStart(countWidth)}${refs ? `  ${refs}` : ''}`
    }),
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The weekly counts as CSV for a spreadsheet: a row per week, a column per
 * link (in the By link order) after the week's total, empty weeks included.
 * Refs are slugs, so no field needs quoting.
 * @param {ReturnType<typeof countSignups>} counts
 * @returns {string}
 */
export function signupReportCsv(counts) {
  const refs = counts.byRef.map((r) => r.ref)
  const rows = [['week_of', 'signups', ...refs].join(',')]
  for (const week of counts.byWeek) {
    const inWeek = new Map(week.byRef.map((r) => [r.ref, r.signups]))
    rows.push([week.weekOf, week.signups, ...refs.map((ref) => inWeek.get(ref) ?? 0)].join(','))
  }
  return `${rows.join('\n')}\n`
}
