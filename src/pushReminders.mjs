// Deadline reminders over Web Push (issue #9) and to the native app's Expo
// push tokens (issue #194).
//
// Pure pieces (selection, copy, settings validation) live here next to the
// runner so test/pushReminders.test.mjs can cover the decisions without a
// database. The runner takes the service-role Supabase client and the VAPID
// keys from server.mjs, and is triggered by POST /api/internal/push/run-reminders,
// which the Supabase pg_cron job in db/supabase-push.sql calls every 5 minutes
// (the same mechanism that keeps the Render instance awake, issue #164).
//
// One reminder per item, ever: push_deliveries (user_id, item_key) is claimed
// with an INSERT before sending, so two overlapping runs cannot both notify.
// If the send then fails there is no retry in v1; the item simply stays quiet.
// The claim covers every device the student gets reminders on: the browsers in
// push_subscriptions and the phones in push_devices, apart from phones with
// local reminders (below). The VAPID keys stay the master switch for both, so
// unsetting them still pauses everything.
//
// loadPushDevices and deliverToPushDevices are the Expo half, shared with the
// test send in src/routes/push.mjs. A missing push_devices table (before
// db/supabase-push-devices.sql runs) reads as no phones, so Web Push carries on.
//
// A phone whose app schedules the student's class and task reminders itself
// registers with localReminders: true (Antoniodeoliveirasegura/boilerindy-app#55),
// stored in push_devices.local_reminders by db/supabase-push-local-reminders.sql
// (README step 47). The deadline run sends such a phone no reminders, or the
// student would see each one twice, and still sends to their browsers and
// other phones. The favorite-dish alerts, which the phone cannot know ahead of
// time, and the test send ignore the flag. Before step 47 the column is
// missing, and withLocalRemindersColumn reads every phone as having it off.
//
// The reminders are the `deadline` kind of the kind registry
// (src/notificationKinds.mjs, issue #550), and the evening list the
// `deadline-digest` kind: on a phone each expires when its first item is due.
// Once README step 53 has run, the student's choices by kind decide what goes
// (the list, the reminder before each item) and the policy in
// src/pushPolicy.mjs when: quiet hours, the 30-minute merge and the daily cap.
// PUSH_KINDS_OFF stops either kind before anything of it is claimed.

import { sendWebPush } from './webPush.mjs'
import { MAX_DEVICE_STRIKES, buildExpoMessages, sendExpoPush } from './expoPush.mjs'
import { queryError } from './cronTick.mjs'
import { DB_FEATURES, logSchemaMissingOnce } from './dbErrors.mjs'
import { isMissingColumnError } from './moderation.mjs'
import { notificationKind } from './notificationKinds.mjs'
import {
  ALL_DAY_REMINDER_MINUTE,
  CAPPED_KINDS,
  DAILY_CAP,
  DEFAULT_DIGEST_MINUTE,
  DEFAULT_QUIET,
  MERGE_MINUTES,
  campusDay,
  campusYmd,
  digestWindow,
  isDayMinute,
  isQuietMinute,
  mergeByDue,
  quietWindow,
} from './pushPolicy.mjs'
import { minutesInZone } from './diningMeals.mjs'
import { zonedTimeMs } from './campusTime.mjs'

export const DEADLINE_CATEGORIES = ['assignment', 'quiz', 'exam', 'project', 'deadline']
export const LEAD_MINUTES_MIN = 5
export const LEAD_MINUTES_MAX = 7 * 24 * 60
export const DEFAULT_LEAD_MINUTES = 60
// Items whose due moment slipped past `now` by less than this still get the
// reminder: the cron has 5 minute granularity and Render may wake up late.
export const GRACE_MINUTES = 5
export const CAMPUS_TIME_ZONE = 'America/Indiana/Indianapolis'
export const REMINDER_URL = '/assignments'

const CATEGORY_WORD = {
  assignment: 'Assignment',
  quiz: 'Quiz',
  exam: 'Exam',
  project: 'Project',
  deadline: 'Deadline',
  manual_task: 'Task',
}

export function normalizeLeadMinutes(value) {
  const n = Number(value)
  if (!Number.isInteger(n)) return null
  if (n < LEAD_MINUTES_MIN || n > LEAD_MINUTES_MAX) return null
  return n
}

/** The Classes kind's lead times (the CHECK on push_settings.class_lead_minutes). */
export const CLASS_LEAD_CHOICES = Object.freeze([...notificationKind('class').default.leadChoices])

// The choices by kind (issue #550, README step 53), with their columns.
export const KIND_SETTING_COLUMNS = Object.freeze([
  'class_reminders',
  'class_lead_minutes',
  'digest_minute',
  'deadline_items',
  'quiet_start',
  'quiet_end',
  'campus_alerts',
  'kinds_migrated_at',
])

/**
 * A new account's settings. The choices by kind start as the kind registry
 * says: classes off, 15 minutes ahead; the evening list at 6:00 PM, with no
 * reminder before each item; quiet hours 11:00 PM to 8:00 AM; campus alerts on.
 */
export function defaultPushSettings() {
  return {
    deadlineReminders: true,
    leadMinutes: DEFAULT_LEAD_MINUTES,
    diningFavoriteAlerts: false,
    classReminders: false,
    classLeadMinutes: notificationKind('class').default.leadMinutes,
    digestMinute: DEFAULT_DIGEST_MINUTE,
    deadlineItems: false,
    quietStart: DEFAULT_QUIET.start,
    quietEnd: DEFAULT_QUIET.end,
    campusAlerts: true,
    kindsMigrated: false,
  }
}

// diningFavoriteAlerts (issue #469) is off unless the row says true, which also
// covers a row read before db/supabase-dining-favorite-alerts.sql ran. A row
// read before README step 53 has none of the choices by kind, and gets what
// that step gives every existing row: its per-item reminders kept
// (deadlineItems follows deadlineReminders), the 6:00 PM list and quiet hours.
// A null digestMinute is no evening list, and a null quiet pair no quiet hours.
export function settingsFromRow(row) {
  if (!row) return defaultPushSettings()
  const defaults = defaultPushSettings()
  const deadlineReminders = row.deadline_reminders !== false
  const has = (column) => Object.hasOwn(row, column)
  const quiet = has('quiet_start') || has('quiet_end') ? quietWindow(row.quiet_start, row.quiet_end) : quietWindow(defaults.quietStart, defaults.quietEnd)
  return {
    deadlineReminders,
    leadMinutes: normalizeLeadMinutes(row.lead_minutes) ?? DEFAULT_LEAD_MINUTES,
    diningFavoriteAlerts: row.dining_favorite_alerts === true,
    classReminders: row.class_reminders === true,
    classLeadMinutes: CLASS_LEAD_CHOICES.includes(row.class_lead_minutes) ? row.class_lead_minutes : defaults.classLeadMinutes,
    digestMinute: has('digest_minute') ? (isDayMinute(row.digest_minute) ? row.digest_minute : null) : defaults.digestMinute,
    deadlineItems: has('deadline_items') ? row.deadline_items === true : deadlineReminders,
    quietStart: quiet ? quiet.start : null,
    quietEnd: quiet ? quiet.end : null,
    campusAlerts: row.campus_alerts !== false,
    kindsMigrated: Boolean(row.kinds_migrated_at),
  }
}

/**
 * Validate a PUT /api/push/settings body. Returns { ok, patch, kinds } with
 * the columns to write, `kinds` true when the patch touches a column of README
 * step 53, or { ok: false, error }. Quiet hours change as a pair, both
 * minutes or both null (off). Whether the evening list falls inside quiet
 * hours depends on the saved settings too: settingsConflict checks that.
 */
export function parseSettingsPatch(body) {
  const input = body && typeof body === 'object' ? body : {}
  const patch = {}
  const bool = (key, column) => {
    if (!(key in input)) return null
    if (typeof input[key] !== 'boolean') return `${key} must be true or false`
    patch[column] = input[key]
    return null
  }
  if ('leadMinutes' in input) {
    const lead = normalizeLeadMinutes(input.leadMinutes)
    if (lead === null) {
      return { ok: false, error: `leadMinutes must be a whole number between ${LEAD_MINUTES_MIN} and ${LEAD_MINUTES_MAX}` }
    }
    patch.lead_minutes = lead
  }
  for (const [key, column] of [
    ['deadlineReminders', 'deadline_reminders'],
    ['diningFavoriteAlerts', 'dining_favorite_alerts'],
    ['classReminders', 'class_reminders'],
    ['deadlineItems', 'deadline_items'],
    ['campusAlerts', 'campus_alerts'],
  ]) {
    const error = bool(key, column)
    if (error) return { ok: false, error }
  }
  if ('classLeadMinutes' in input) {
    if (!CLASS_LEAD_CHOICES.includes(input.classLeadMinutes)) {
      return { ok: false, error: `classLeadMinutes must be one of ${CLASS_LEAD_CHOICES.join(', ')}` }
    }
    patch.class_lead_minutes = input.classLeadMinutes
  }
  if ('digestMinute' in input) {
    if (input.digestMinute !== null && !isDayMinute(input.digestMinute)) {
      return { ok: false, error: 'digestMinute must be null or a whole number of minutes past midnight, 0 to 1439' }
    }
    patch.digest_minute = input.digestMinute
  }
  if ('quietStart' in input || 'quietEnd' in input) {
    const { quietStart: start, quietEnd: end } = input
    if (!('quietStart' in input && 'quietEnd' in input)) return { ok: false, error: 'quietStart and quietEnd change together' }
    const off = start === null && end === null
    if (!off && !(isDayMinute(start) && isDayMinute(end))) {
      return { ok: false, error: 'quietStart and quietEnd must both be null or both be minutes past midnight, 0 to 1439' }
    }
    if (!off && start === end) return { ok: false, error: 'Quiet hours need a start and an end that differ.' }
    patch.quiet_start = start
    patch.quiet_end = end
  }
  if ('kindsMigrated' in input) {
    if (input.kindsMigrated !== true) return { ok: false, error: 'kindsMigrated can only be set to true' }
    patch.kinds_migrated_at = true
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to update' }
  return { ok: true, patch, kinds: KIND_SETTING_COLUMNS.some((column) => column in patch) }
}

/**
 * Why a full set of settings cannot be saved, or null: the evening list may
 * not go out inside quiet hours (it is never sent there).
 */
export function settingsConflict(settings) {
  const quiet = quietWindow(settings.quietStart, settings.quietEnd)
  if (settings.digestMinute !== null && isQuietMinute(settings.digestMinute, quiet)) {
    return 'The evening list cannot go out during quiet hours. Pick a time outside them.'
  }
  return null
}

function zoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date)
  const name = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT'
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0))
}

function dateKeyInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** 23:59 local time on a YYYY-MM-DD date in the campus time zone, as a Date. */
export function endOfDayInZone(dateKey, timeZone = CAMPUS_TIME_ZONE) {
  const guess = new Date(`${dateKey}T23:59:00Z`)
  const offset = zoneOffsetMinutes(guess, timeZone)
  return new Date(guess.getTime() - offset * 60_000)
}

/**
 * The instant an item is due. Date-only feed items (allDay) are stored at
 * 00:00 UTC of their date by the sync (Render runs in UTC), and the app shows
 * them as "due by end of day", so the reminder treats them as due at 23:59
 * campus time on that date.
 */
export function dueMomentOf(item) {
  if (!item || !item.startTime) return null
  const start = new Date(item.startTime)
  if (Number.isNaN(start.getTime())) return null
  if (!item.allDay) return start
  const isUtcMidnight = start.getUTCHours() === 0 && start.getUTCMinutes() === 0 && start.getUTCSeconds() === 0
  const dateKey = isUtcMidnight ? start.toISOString().slice(0, 10) : dateKeyInZone(start, CAMPUS_TIME_ZONE)
  return endOfDayInZone(dateKey)
}

/**
 * Pick the items that deserve a reminder right now: not completed, not already
 * delivered, and due within (now - grace, now + leadMinutes]. With
 * `allDayAtMinute` (README step 53 onwards), an all-day item is reminded from
 * that minute of its own day instead (9:00 AM, as the app does), not
 * leadMinutes before 11:59 PM.
 */
export function selectDueItems({
  calendarItems = [],
  manualTasks = [],
  completedIds = new Set(),
  deliveredKeys = new Set(),
  now = new Date(),
  leadMinutes = DEFAULT_LEAD_MINUTES,
  graceMinutes = GRACE_MINUTES,
  allDayAtMinute = null,
} = {}) {
  const nowMs = now.getTime()
  const windowStart = nowMs - graceMinutes * 60_000
  const windowEnd = nowMs + leadMinutes * 60_000
  const inWindow = (t) => t >= windowStart && t <= windowEnd
  const out = []

  for (const item of calendarItems) {
    if (!DEADLINE_CATEGORIES.includes(item.category)) continue
    if (completedIds.has(item.id)) continue
    const key = `calendar:${item.id}`
    if (deliveredKeys.has(key)) continue
    const dueAt = dueMomentOf(item)
    if (!dueAt) continue
    if (item.allDay && allDayAtMinute !== null) {
      // Its day's 9:00 AM until it ends: dueMomentOf puts it at 11:59 PM that day.
      const remindAt = zonedTimeMs(campusYmd(dueAt.getTime()), allDayAtMinute)
      if (nowMs < remindAt || dueAt.getTime() < windowStart) continue
    } else if (!inWindow(dueAt.getTime())) {
      continue
    }
    out.push({ key, id: item.id, kind: 'calendar', title: item.title || 'Untitled', category: item.category, dueAt, allDay: Boolean(item.allDay) })
  }

  for (const task of manualTasks) {
    if (task.completedAt) continue
    const key = `manual:${task.id}`
    if (deliveredKeys.has(key)) continue
    const dueAt = task.dueAt ? new Date(task.dueAt) : null
    if (!dueAt || Number.isNaN(dueAt.getTime()) || !inWindow(dueAt.getTime())) continue
    out.push({ key, id: task.id, kind: 'manual', title: task.title || 'Untitled task', category: 'manual_task', dueAt, allDay: false })
  }

  out.sort((a, b) => a.dueAt - b.dueAt)
  return out
}

/**
 * What an evening list names: every item not completed and due after
 * `fromMs`, up to `untilMs` (the next day's list), whether or not it also got
 * its own reminder. Sorted by due time.
 */
export function selectDigestItems({ calendarItems = [], manualTasks = [], completedIds = new Set(), fromMs, untilMs }) {
  const inWindow = (t) => t > fromMs && t <= untilMs
  const out = []
  for (const item of calendarItems) {
    if (!DEADLINE_CATEGORIES.includes(item.category) || completedIds.has(item.id)) continue
    const dueAt = dueMomentOf(item)
    if (dueAt && inWindow(dueAt.getTime())) out.push({ key: `calendar:${item.id}`, id: item.id, kind: 'calendar', title: item.title || 'Untitled', dueAt })
  }
  for (const task of manualTasks) {
    if (task.completedAt) continue
    const dueAt = task.dueAt ? new Date(task.dueAt) : null
    if (dueAt && !Number.isNaN(dueAt.getTime()) && inWindow(dueAt.getTime())) {
      out.push({ key: `manual:${task.id}`, id: task.id, kind: 'manual', title: task.title || 'Untitled task', dueAt })
    }
  }
  return out.sort((a, b) => a.dueAt - b.dueAt)
}

export function describeDueIn(dueAt, now = new Date()) {
  const minutes = Math.round((dueAt.getTime() - now.getTime()) / 60_000)
  if (minutes <= 0) return 'due now'
  if (minutes < 60) return `due in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest ? `due in ${hours} h ${rest} min` : `due in ${hours} h`
  const days = Math.round(minutes / (60 * 24))
  return `due in ${days} day${days === 1 ? '' : 's'}`
}

export function formatDueTime(dueAt, { now = new Date(), timeZone = CAMPUS_TIME_ZONE } = {}) {
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(dueAt)
  const dueKey = dateKeyInZone(dueAt, timeZone)
  const todayKey = dateKeyInZone(now, timeZone)
  if (dueKey === todayKey) return `at ${time}`
  const tomorrowKey = dateKeyInZone(new Date(now.getTime() + 24 * 60 * 60_000), timeZone)
  if (dueKey === tomorrowKey) return `tomorrow at ${time}`
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(dueAt)
  return `${weekday} at ${time}`
}

/**
 * The page a reminder opens: the task itself (issue #550, item 5),
 * /assignments?taskId=<id>&taskKind=calendar|manual. The website's
 * Assignments page opens that task's details, and the app maps the same path
 * to its Tasks screen (reading `calendar` as its `imported`).
 */
export function deadlineItemUrl(item) {
  return `${REMINDER_URL}?${new URLSearchParams({ taskId: String(item.id), taskKind: item.kind })}`
}

// `itemId` and `itemKind` ('calendar' or 'manual') name the task for the
// app's actions, as the url does for a tap. `expiresAt` is the due moment: an
// undelivered reminder is worth nothing after it, so the phone's copy is kept
// until then (expoTtlSeconds).
export function buildDeadlinePayload(item, now = new Date()) {
  const label = CATEGORY_WORD[item.category] || 'Deadline'
  return {
    title: `${label} ${describeDueIn(item.dueAt, now)}`,
    body: `${item.title} is due ${formatDueTime(item.dueAt, { now })}.`,
    url: deadlineItemUrl(item),
    tag: `deadline-${item.key}`.replace(/[^A-Za-z0-9_-]/g, '-'),
    kind: 'deadline',
    itemId: String(item.id),
    itemKind: item.kind,
    expiresAt: item.dueAt.toISOString(),
  }
}

// "A", "A and B", "A, B and C"; three names at most, then "and N more".
function namesOf(items) {
  const named = items.slice(0, 3).map((item) => item.title)
  const words = items.length > named.length ? [...named, `${items.length - named.length} more`] : named
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0]
}

const CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: CAMPUS_TIME_ZONE, hour: 'numeric', minute: '2-digit' })

/**
 * Deadlines due within MERGE_MINUTES of each other, as one reminder (issue
 * #550): "3 due in 1 h" / "HW 3, Quiz 4 and Lab 2 report are due by 11:59 PM."
 * It opens the task list, and is kept until the first of them is due.
 */
export function buildDeadlineGroupPayload(items, now = new Date()) {
  const [first] = items
  const last = items[items.length - 1]
  const when = formatDueTime(last.dueAt, { now })
  return {
    title: `${items.length} ${describeDueIn(first.dueAt, now)}`,
    body: `${namesOf(items)} are due ${when.startsWith('at ') ? `by ${when.slice(3)}` : `by ${when}`}.`,
    url: REMINDER_URL,
    tag: `deadline-${first.key}`.replace(/[^A-Za-z0-9_-]/g, '-'),
    kind: 'deadline',
    expiresAt: first.dueAt.toISOString(),
  }
}

/**
 * The evening list for the campus date `ymd` (issue #550, item 3): one push
 * naming what is due before the next day's list, "3 due tonight" / "By 11:59
 * PM" / "HW 3, Quiz 4 and Lab 2 report." When something on it is due later
 * than today, the title says by when instead. Kept until the first item is due.
 */
export function buildDigestPayload(items, ymd, now = new Date()) {
  const [first] = items
  const last = items[items.length - 1]
  const todayOnly = campusYmd(last.dueAt.getTime()) === ymd
  const evening = minutesInZone(now) >= 17 * 60
  return {
    title: todayOnly ? `${items.length} due ${evening ? 'tonight' : 'today'}` : `${items.length} due by ${formatDueTime(last.dueAt, { now })}`,
    subtitle: todayOnly ? `By ${CLOCK.format(last.dueAt)}` : `First due ${formatDueTime(first.dueAt, { now })}`,
    body: `${namesOf(items)}.`,
    url: REMINDER_URL,
    tag: `deadline-digest-${ymd}`,
    kind: 'deadline-digest',
    expiresAt: first.dueAt.toISOString(),
  }
}

/**
 * The test push, worded for the device it reaches (issue #550, item 2). A
 * phone whose app schedules the student's class and task reminders itself
 * (local reminders, boilerindy-app#55) gets only the favorite-dish alerts from
 * here, so it says so rather than promising deadline reminders it will never
 * get. Browsers and every other phone get the deadline reminders, and keep
 * the old words.
 */
export function buildTestPayload({ localReminders = false, platform = null } = {}) {
  const payload = { url: '/settings', tag: 'test', kind: 'test' }
  if (localReminders) {
    return {
      title: `Notifications are on for this ${platform === 'android' ? 'phone' : 'iPhone'}`,
      body: 'Favorite dish alerts come here. Class and task reminders come from the phone itself.',
      ...payload,
    }
  }
  return { title: 'BoilerIndy notifications are on', body: 'You will get deadline reminders on this device.', ...payload }
}

/** Supabase reports a missing table as PGRST205 (schema cache) or 42P01. */
export function isMissingTableError(error) {
  if (!error) return false
  if (error.code === 'PGRST205' || error.code === '42P01') return true
  return /does not exist|schema cache/i.test(String(error.message || ''))
}

// README step 47, for the log line that names it while the column is missing.
const LOCAL_REMINDERS_SCHEMA = { feature: 'push_local_reminders', sqlFile: 'db/supabase-push-local-reminders.sql' }

/**
 * Run a push_devices query that reads or writes local_reminders, and run it
 * again without the column while README step 47 has not added it, so that a
 * missing column never stops a phone from registering or getting its pushes.
 * `buildQuery(true)` names the column and `buildQuery(false)` must not. Run
 * this before the missing-table check: isMissingTableError also matches a
 * missing column's "does not exist" and "schema cache" messages, and would
 * read every phone as gone. The fallback logs the file to run once per process
 * (logSchemaMissingOnce), and its rows carry no local_reminders, which every
 * caller reads as false.
 * @template R
 * @param {(withFlag: boolean) => PromiseLike<R>} buildQuery
 * @returns {Promise<R>}
 */
export async function withLocalRemindersColumn(buildQuery) {
  const result = await buildQuery(true)
  if (!isMissingColumnError(result?.error, 'local_reminders')) return result
  logSchemaMissingOnce(LOCAL_REMINDERS_SCHEMA, result.error)
  return buildQuery(false)
}

// README steps 54 and 55, likewise.
const DEVICE_KINDS_SCHEMA = { feature: 'push_device_kinds', sqlFile: 'db/supabase-push-device-kinds.sql' }
const TICKETS_SCHEMA = { feature: 'push_tickets', sqlFile: 'db/supabase-push-tickets.sql' }

/**
 * Run a push_devices query that reads or writes what a phone reports at
 * registration (issue #550: kinds, channels, kinds_version, redact and
 * activity_start_token, README step 54) as well as local_reminders (step 47),
 * stepping down while a step has not run. `buildQuery({ kinds, local })` names
 * the columns of the steps it is told exist. A missing local_reminders means
 * step 54 is missing too, since it comes later, so that goes straight to
 * neither. Each fallback logs its file once; rows without the columns read as
 * an older build (no kinds) with local reminders off.
 * @template R
 * @param {(columns: { kinds: boolean, local: boolean }) => PromiseLike<R>} buildQuery
 * @returns {Promise<R>}
 */
export async function withDeviceColumns(buildQuery) {
  const full = await buildQuery({ kinds: true, local: true })
  if (!isMissingColumnError(full?.error)) return full
  if (String(full.error.message || '').includes('local_reminders')) {
    logSchemaMissingOnce(LOCAL_REMINDERS_SCHEMA, full.error)
    return buildQuery({ kinds: false, local: false })
  }
  logSchemaMissingOnce(DEVICE_KINDS_SCHEMA, full.error)
  return withLocalRemindersColumn((local) => buildQuery({ kinds: false, local }))
}

/**
 * Whether a phone takes a server push of `kind` (issue #550, item 4). A phone
 * that listed its kinds at registration takes those only, and the test push,
 * which a student sends to check every device; a kind it schedules itself is
 * never on its list, so nothing reaches it twice. An older build, with no
 * list, follows README step 47: no deadline pushes to a phone with local
 * reminders on.
 */
export function deviceTakes(device, kind) {
  if (Array.isArray(device.kinds)) return kind === 'test' || device.kinds.includes(kind)
  if (kind === 'deadline' || kind === 'deadline-digest') return device.local_reminders !== true
  return true
}

/**
 * The phones to send to for these students: push_devices rows as
 * { id, user_id, token, platform, failure_count, local_reminders, kinds,
 * channels }, where local_reminders is missing before README step 47 runs
 * (read as false) and kinds and channels before step 54 (an older build). A
 * device that has reached MAX_DEVICE_STRIKES is deleted here and left out,
 * which is how a device with five strikes is "skipped and deleted on the next
 * run". A missing table reads as no devices; any other database error throws a
 * SupabaseQueryError, so the cron route can tell a Supabase hiccup from a bug.
 * Every phone is returned: deliverToPushDevices sends each push only to the
 * phones that take its kind (deviceTakes). Returns { devices, removed }.
 */
export async function loadPushDevices(client, userIds, { log = console } = {}) {
  if (!userIds.length) return { devices: [], removed: 0 }
  const res = await withDeviceColumns(({ kinds, local }) =>
    client
      .from('push_devices')
      .select(['id, user_id, token, platform, failure_count', ...(local ? ['local_reminders'] : []), ...(kinds ? ['kinds', 'channels'] : [])].join(', '))
      .in('user_id', userIds),
  )
  if (res.error) {
    if (isMissingTableError(res.error)) return { devices: [], removed: 0 }
    throw queryError(res, 'push_devices select')
  }
  const rows = res.data || []
  const struckOut = rows.filter((row) => (row.failure_count || 0) >= MAX_DEVICE_STRIKES)
  let removed = 0
  if (struckOut.length) {
    const del = await client.from('push_devices').delete().in('id', struckOut.map((row) => row.id))
    if (del.error) {
      log.warn(`[push] could not drop ${struckOut.length} native device(s) after ${MAX_DEVICE_STRIKES} failed deliveries: ${del.error.message || del.error}`)
    } else {
      removed = struckOut.length
    }
  }
  return { devices: rows.filter((row) => (row.failure_count || 0) < MAX_DEVICE_STRIKES), removed }
}

// Keeps the Expo ticket of each message for its receipt (README step 55,
// src/pushReceipts.mjs). Bookkeeping only: before step 55 the table is missing
// and the log names the file once, and any other failure is logged by its code
// and never fails the send.
async function keepTickets(client, tickets, log) {
  if (!tickets.length) return
  try {
    const res = await client.from('push_tickets').insert(tickets)
    if (!res?.error) return
    if (isMissingTableError(res.error)) logSchemaMissingOnce(TICKETS_SCHEMA, res.error)
    else log.warn(`[push] could not keep ${tickets.length} Expo ticket(s) (${res.error.code || 'error'})`)
  } catch (error) {
    log.warn(`[push] could not keep ${tickets.length} Expo ticket(s) (${error?.code || 'error'})`)
  }
}

/**
 * Send one payload to a student's phones through Expo and keep the books on
 * each row: a success clears the strikes, DeviceNotRegistered deletes the
 * row, and a strike adds one to failure_count (see src/expoPush.mjs for which
 * errors are strikes). Only the phones that take the payload's kind get it
 * (deviceTakes); the rest pass through untouched. Each ticket Expo answers is
 * kept for its receipt. Returns { sent, failed, removed, devices }, where
 * `devices` is what is left to send the next item to, with the updated counts.
 * `now` is the clock the messages' lifetimes are counted from.
 */
export async function deliverToPushDevices({ client, devices, payload, send = sendExpoPush, log = console, now = new Date() }) {
  const outcome = { sent: 0, failed: 0, removed: 0, devices: [] }
  const live = devices.filter((row) => (row.failure_count || 0) < MAX_DEVICE_STRIKES)
  const taking = live.filter((row) => deviceTakes(row, payload.kind))
  outcome.devices.push(...live.filter((row) => !taking.includes(row)))
  if (taking.length === 0) return outcome
  const results = await send({ messages: buildExpoMessages(taking, payload, { now }) })
  const tickets = []
  for (const [i, row] of taking.entries()) {
    const result = results[i] || { ok: false, error: 'no_ticket', gone: false, strike: false }
    if (result.ok) {
      outcome.sent += 1
      if (result.ticketId) tickets.push({ ticket_id: result.ticketId, kind: payload.kind, device_id: row.id, sent_at: now.toISOString() })
      if (row.failure_count) {
        await client.from('push_devices').update({ failure_count: 0 }).eq('id', row.id)
      }
      outcome.devices.push({ ...row, failure_count: 0 })
      continue
    }
    outcome.failed += 1
    if (result.gone) {
      const del = await client.from('push_devices').delete().eq('id', row.id)
      if (!del.error) outcome.removed += 1
      continue
    }
    log.warn(`[push] native delivery failed (${result.error})`)
    if (result.strike) {
      const strikes = (row.failure_count || 0) + 1
      await client.from('push_devices').update({ failure_count: strikes }).eq('id', row.id)
      outcome.devices.push({ ...row, failure_count: strikes })
    } else {
      outcome.devices.push(row)
    }
  }
  await keepTickets(client, tickets, log)
  return outcome
}

// The student's open deadlines that could matter between now and `untilMs`:
// calendar items and manual tasks, which calendar items are done, and which
// items already had their reminder. Date-only rows sit at 00:00 of their date
// and are due at 23:59 campus time, so the query reaches a day back; the
// selections apply the real windows afterwards.
async function loadDeadlineItems(client, userId, { now, untilMs }) {
  const lowerIso = new Date(now.getTime() - 25 * 60 * 60_000).toISOString()
  const upperIso = new Date(untilMs).toISOString()
  const [calRes, manualRes] = await Promise.all([
    client
      .from('calendar_items')
      .select('id, title, start_time, category, all_day')
      .eq('user_id', userId)
      .in('category', DEADLINE_CATEGORIES)
      .gte('start_time', lowerIso)
      .lte('start_time', upperIso)
      .limit(200),
    client
      .from('user_manual_tasks')
      .select('id, title, due_at, completed_at')
      .eq('user_id', userId)
      .is('completed_at', null)
      .gte('due_at', lowerIso)
      .lte('due_at', upperIso)
      .limit(200),
  ])
  if (calRes.error) throw queryError(calRes, 'calendar_items select')
  if (manualRes.error) throw queryError(manualRes, 'user_manual_tasks select')

  const calendarItems = (calRes.data || []).map((r) => ({
    id: r.id,
    title: r.title,
    startTime: r.start_time,
    category: r.category,
    allDay: Boolean(r.all_day),
  }))
  const manualTasks = (manualRes.data || []).map((r) => ({
    id: r.id,
    title: r.title,
    dueAt: r.due_at,
    completedAt: r.completed_at,
  }))

  let completedIds = new Set()
  const calendarIds = calendarItems.map((i) => i.id)
  if (calendarIds.length) {
    const res = await client
      .from('user_task_completions')
      .select('calendar_item_id')
      .eq('user_id', userId)
      .in('calendar_item_id', calendarIds)
    if (res.error) throw queryError(res, 'user_task_completions select')
    completedIds = new Set((res.data || []).map((r) => r.calendar_item_id))
  }

  let deliveredKeys = new Set()
  const keys = [...calendarItems.map((i) => `calendar:${i.id}`), ...manualTasks.map((t) => `manual:${t.id}`)]
  if (keys.length) {
    const res = await client.from('push_deliveries').select('item_key').eq('user_id', userId).in('item_key', keys)
    if (res.error) throw queryError(res, 'push_deliveries select')
    deliveredKeys = new Set((res.data || []).map((r) => r.item_key))
  }

  return { calendarItems, manualTasks, completedIds, deliveredKeys }
}

/**
 * How many of today's capped server pushes (the evening list, reminders, dish
 * alerts: the registry's `cap: 'daily'`) a student has had since campus
 * midnight, counted from their claims in push_deliveries. A merged reminder's
 * extra items are claimed as `deadline-merged`, so it counts once.
 */
export async function countCappedToday(client, userId, now = new Date()) {
  const res = await client
    .from('push_deliveries')
    .select('kind')
    .eq('user_id', userId)
    .in('kind', CAPPED_KINDS)
    .gte('sent_at', new Date(campusDay(now.getTime()).start).toISOString())
  if (res.error) throw queryError(res, 'push_deliveries select (daily cap)')
  return (res.data || []).length
}

// Claims each item of one reminder push: the first as `deadline`, the rest as
// `deadline-merged`, so the daily cap counts the push once. An item another
// run claimed first is left out. Returns the items this run claimed.
async function claimReminder(client, userId, group, now) {
  const claimed = []
  for (const item of group) {
    const kind = claimed.length ? 'deadline-merged' : 'deadline'
    const claim = await client.from('push_deliveries').insert({ user_id: userId, item_key: item.key, kind, sent_at: now.toISOString() })
    if (claim.error) {
      if (claim.error.code === '23505') continue
      throw queryError(claim, 'push_deliveries insert')
    }
    claimed.push(item)
  }
  return claimed
}

/**
 * The reminders due now, as the groups that go out as one push each. With
 * `merge` (README step 53 onwards) a reminder whose time has come takes along
 * the items due within MERGE_MINUTES after its own, though theirs has not come
 * yet, so three items due at 11:59 PM make one push an hour before, not three
 * a few minutes apart. All-day items, reminded at 9:00 AM, merge only with one
 * another. Without `merge`, one item per push, as before.
 */
export function reminderGroups(lists, { now, leadMinutes, merge }) {
  if (!merge) return selectDueItems({ ...lists, now, leadMinutes }).map((item) => [item])
  const candidates = selectDueItems({ ...lists, now, leadMinutes: leadMinutes + MERGE_MINUTES, allDayAtMinute: ALL_DAY_REMINDER_MINUTE })
  const dueBy = now.getTime() + leadMinutes * 60_000
  const timed = mergeByDue(candidates.filter((item) => !item.allDay)).filter((group) => group[0].dueAt.getTime() <= dueBy)
  return [...mergeByDue(candidates.filter((item) => item.allDay)), ...timed]
}

// What the run reads per student, with README step 53 and before it.
const SETTINGS_WITH_KINDS = 'user_id, lead_minutes, deadline_items, digest_minute, quiet_start, quiet_end'
const SETTINGS_BEFORE_KINDS = 'user_id, lead_minutes'

/**
 * Send what is due, once. Returns a summary for the cron log; throws a
 * SupabaseQueryError (status and code kept, see cronTick.mjs) on database
 * errors other than "tables not installed", so the route can tell a Supabase
 * hiccup worth one retry from a bug.
 *
 * For each student with deadlines on (issue #550, items 3 and 8, once README
 * step 53 has run):
 *
 * - the evening list at their digest minute: one push a day naming what is
 *   due before the next day's list, claimed as `deadline-digest:<date>`, and
 *   never sent inside quiet hours (a list that would be is skipped that day);
 * - with deadlineItems on, a reminder leadMinutes before each item, an
 *   all-day item at 9:00 AM on its day, items due within 30 minutes of each
 *   other merged into one push. Inside quiet hours nothing is claimed, so a
 *   reminder goes when they end if its item is not due by then;
 * - at most DAILY_CAP of these pushes and the dish alerts a day: past it,
 *   nothing more is claimed until campus midnight.
 *
 * Before step 53 it sends a reminder before every item, as it did. With
 * `deadline` in `kindsOff` (PUSH_KINDS_OFF) the reminders stop, with
 * `deadline-digest` the lists; with both it reads nothing and claims
 * nothing, so an item still in its window when they are turned back on gets
 * its reminder then.
 */
export async function runDeadlineReminders({
  client,
  keys,
  now = new Date(),
  send = sendWebPush,
  sendExpo = sendExpoPush,
  kindsOff = new Set(),
  maxUsers = 200,
  maxSends = 300,
  log = console,
}) {
  const summary = { ok: true, ranAt: now.toISOString(), users: 0, checked: 0, sent: 0, failed: 0, removed: 0, skipped: 0, digests: 0, held: 0, capped: 0 }
  if (!keys) return { ...summary, ok: false, reason: 'no_vapid_keys' }
  const itemsOn = !kindsOff.has('deadline')
  const digestsOn = !kindsOff.has('deadline-digest')
  if (!itemsOn && !digestsOn) return { ...summary, ok: false, reason: 'kind_off' }

  let kindsAvailable = true
  const readSettings = (columns) => client.from('push_settings').select(columns).eq('deadline_reminders', true).limit(maxUsers)
  let settingsRes = await readSettings(SETTINGS_WITH_KINDS)
  if (settingsRes.error && isMissingColumnError(settingsRes.error)) {
    // Before README step 53: a reminder before every item, as before.
    kindsAvailable = false
    logSchemaMissingOnce(DB_FEATURES.push_kinds, settingsRes.error)
    settingsRes = await readSettings(SETTINGS_BEFORE_KINDS)
  }
  if (settingsRes.error) {
    if (isMissingTableError(settingsRes.error)) return { ...summary, ok: false, reason: 'not_configured' }
    throw queryError(settingsRes, 'push_settings select')
  }
  const settingsRows = settingsRes.data || []
  if (settingsRows.length === 0) return summary

  const userIds = settingsRows.map((r) => r.user_id)
  const subsRes = await client
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth')
    .in('user_id', userIds)
  if (subsRes.error) throw queryError(subsRes, 'push_subscriptions select')
  const subsByUser = new Map()
  for (const sub of subsRes.data || []) {
    if (!subsByUser.has(sub.user_id)) subsByUser.set(sub.user_id, [])
    subsByUser.get(sub.user_id).push(sub)
  }
  const loaded = await loadPushDevices(client, userIds, { log })
  summary.removed += loaded.removed
  const devicesByUser = new Map()
  for (const device of loaded.devices) {
    if (!devicesByUser.has(device.user_id)) devicesByUser.set(device.user_id, [])
    devicesByUser.get(device.user_id).push(device)
  }

  const nowMs = now.getTime()
  const today = campusYmd(nowMs)
  for (const row of settingsRows) {
    let subs = subsByUser.get(row.user_id) || []
    let devices = devicesByUser.get(row.user_id) || []
    // A phone that schedules the student's deadlines itself (it does not list
    // them, or an older build with local reminders on) would get a second
    // copy, so it takes none from here (deviceTakes). A student none of whose
    // devices takes them is skipped like one with no devices, and nothing is
    // claimed, so an item still gets its reminder if that changes before it is due.
    const reaches = (kind) => subs.length > 0 || devices.some((device) => deviceTakes(device, kind))
    if (!reaches('deadline') && !reaches('deadline-digest')) {
      summary.skipped += 1
      continue
    }
    summary.users += 1
    const settings = settingsFromRow(row)
    const quiet = kindsAvailable ? quietWindow(settings.quietStart, settings.quietEnd) : null
    const quietNow = isQuietMinute(minutesInZone(now), quiet)
    const digest = kindsAvailable && digestsOn && settings.digestMinute !== null ? digestWindow(today, settings.digestMinute) : null
    const digestDue = Boolean(digest) && nowMs >= digest.at && !quietNow && reaches('deadline-digest')
    const itemsDue = itemsOn && settings.deadlineItems && reaches('deadline')
    if (!digestDue && !itemsDue) continue

    const lists = await loadDeadlineItems(client, row.user_id, {
      now,
      untilMs: Math.max(nowMs + settings.leadMinutes * 60_000, digestDue ? digest.until : 0),
    })

    // Today's capped pushes, counted when something is about to go.
    let sentToday = null
    const underCap = async () => {
      if (!kindsAvailable) return true
      if (sentToday === null) sentToday = await countCappedToday(client, row.user_id, now)
      return sentToday < DAILY_CAP
    }
    const deliver = async (payload) => {
      for (const sub of subs) {
        const result = await send({
          subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          keys,
          topic: payload.tag,
          now: nowMs,
        })
        if (result.ok) {
          summary.sent += 1
          continue
        }
        summary.failed += 1
        if (result.gone) {
          const del = await client.from('push_subscriptions').delete().eq('id', sub.id)
          if (!del.error) summary.removed += 1
          subs = subs.filter((s) => s.id !== sub.id)
        } else {
          log.warn(`[push] reminder delivery failed (${result.status}): ${result.error}`)
        }
      }
      if (devices.length) {
        const native = await deliverToPushDevices({ client, devices, payload, send: sendExpo, log, now })
        summary.sent += native.sent
        summary.failed += native.failed
        summary.removed += native.removed
        devices = native.devices
      }
      if (sentToday !== null) sentToday += 1
    }

    // The evening list first: one push a day, whatever else is due.
    if (digestDue) {
      const items = selectDigestItems({ ...lists, fromMs: nowMs, untilMs: digest.until })
      if (items.length && !(await underCap())) {
        summary.capped += 1
      } else if (items.length) {
        const claim = await client
          .from('push_deliveries')
          .insert({ user_id: row.user_id, item_key: `deadline-digest:${today}`, kind: 'deadline-digest', sent_at: now.toISOString() })
        if (claim.error && claim.error.code !== '23505') throw queryError(claim, 'push_deliveries insert (digest)')
        if (!claim.error) {
          await deliver(buildDigestPayload(items, today, now))
          summary.digests += 1
        }
      }
    }

    if (!itemsDue) continue
    const groups = reminderGroups(lists, { now, leadMinutes: settings.leadMinutes, merge: kindsAvailable })
    const itemCount = groups.reduce((n, group) => n + group.length, 0)
    summary.checked += itemCount
    if (itemCount && quietNow) {
      // Held, not claimed: they go when quiet hours end, if not due by then.
      summary.held += itemCount
      continue
    }
    for (const group of groups) {
      if (summary.sent + summary.failed >= maxSends) break
      if (!(await underCap())) {
        summary.capped += group.length
        continue
      }
      const claimed = await claimReminder(client, row.user_id, group, now)
      summary.skipped += group.length - claimed.length
      if (!claimed.length) continue
      await deliver(claimed.length === 1 ? buildDeadlinePayload(claimed[0], now) : buildDeadlineGroupPayload(claimed, now))
    }
  }
  return summary
}
