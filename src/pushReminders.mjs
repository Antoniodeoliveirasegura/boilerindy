// Deadline reminders over Web Push (issue #9).
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

import { sendWebPush } from './webPush.mjs'

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

export function defaultPushSettings() {
  return { deadlineReminders: true, leadMinutes: DEFAULT_LEAD_MINUTES }
}

export function settingsFromRow(row) {
  if (!row) return defaultPushSettings()
  return {
    deadlineReminders: row.deadline_reminders !== false,
    leadMinutes: normalizeLeadMinutes(row.lead_minutes) ?? DEFAULT_LEAD_MINUTES,
  }
}

/** Validate a PUT /api/push/settings body. Returns { ok, patch } or { ok: false, error }. */
export function parseSettingsPatch(body) {
  const input = body && typeof body === 'object' ? body : {}
  const patch = {}
  if ('deadlineReminders' in input) {
    if (typeof input.deadlineReminders !== 'boolean') return { ok: false, error: 'deadlineReminders must be true or false' }
    patch.deadline_reminders = input.deadlineReminders
  }
  if ('leadMinutes' in input) {
    const lead = normalizeLeadMinutes(input.leadMinutes)
    if (lead === null) {
      return { ok: false, error: `leadMinutes must be a whole number between ${LEAD_MINUTES_MIN} and ${LEAD_MINUTES_MAX}` }
    }
    patch.lead_minutes = lead
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to update' }
  return { ok: true, patch }
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
 * delivered, and due within (now - grace, now + leadMinutes].
 */
export function selectDueItems({
  calendarItems = [],
  manualTasks = [],
  completedIds = new Set(),
  deliveredKeys = new Set(),
  now = new Date(),
  leadMinutes = DEFAULT_LEAD_MINUTES,
  graceMinutes = GRACE_MINUTES,
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
    if (!dueAt || !inWindow(dueAt.getTime())) continue
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

export function buildDeadlinePayload(item, now = new Date()) {
  const label = CATEGORY_WORD[item.category] || 'Deadline'
  return {
    title: `${label} ${describeDueIn(item.dueAt, now)}`,
    body: `${item.title} is due ${formatDueTime(item.dueAt, { now })}.`,
    url: REMINDER_URL,
    tag: `deadline-${item.key}`.replace(/[^A-Za-z0-9_-]/g, '-'),
    kind: 'deadline',
  }
}

export function buildTestPayload() {
  return {
    title: 'BoilerIndy notifications are on',
    body: 'You will get deadline reminders on this device.',
    url: '/settings',
    tag: 'test',
    kind: 'test',
  }
}

/** Supabase reports a missing table as PGRST205 (schema cache) or 42P01. */
export function isMissingTableError(error) {
  if (!error) return false
  if (error.code === 'PGRST205' || error.code === '42P01') return true
  return /does not exist|schema cache/i.test(String(error.message || ''))
}

async function loadDueCandidates(client, userId, { now, leadMinutes }) {
  // Date-only rows sit at 00:00 of their date and are due at 23:59 campus
  // time, so the query window reaches a day back; selectDueItems applies the
  // real window afterwards.
  const lowerIso = new Date(now.getTime() - 25 * 60 * 60_000).toISOString()
  const upperIso = new Date(now.getTime() + leadMinutes * 60_000).toISOString()
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
  if (calRes.error) throw calRes.error
  if (manualRes.error) throw manualRes.error

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
    if (res.error) throw res.error
    completedIds = new Set((res.data || []).map((r) => r.calendar_item_id))
  }

  let deliveredKeys = new Set()
  const keys = [...calendarItems.map((i) => `calendar:${i.id}`), ...manualTasks.map((t) => `manual:${t.id}`)]
  if (keys.length) {
    const res = await client.from('push_deliveries').select('item_key').eq('user_id', userId).in('item_key', keys)
    if (res.error) throw res.error
    deliveredKeys = new Set((res.data || []).map((r) => r.item_key))
  }

  return selectDueItems({ calendarItems, manualTasks, completedIds, deliveredKeys, now, leadMinutes })
}

/**
 * Send every due reminder once. Returns a summary for the cron log; throws on
 * database errors other than "tables not installed".
 */
export async function runDeadlineReminders({
  client,
  keys,
  now = new Date(),
  send = sendWebPush,
  maxUsers = 200,
  maxSends = 300,
  log = console,
}) {
  const summary = { ok: true, ranAt: now.toISOString(), users: 0, checked: 0, sent: 0, failed: 0, removed: 0, skipped: 0 }
  if (!keys) return { ...summary, ok: false, reason: 'no_vapid_keys' }

  const settingsRes = await client
    .from('push_settings')
    .select('user_id, lead_minutes')
    .eq('deadline_reminders', true)
    .limit(maxUsers)
  if (settingsRes.error) {
    if (isMissingTableError(settingsRes.error)) return { ...summary, ok: false, reason: 'not_configured' }
    throw settingsRes.error
  }
  const settingsRows = settingsRes.data || []
  if (settingsRows.length === 0) return summary

  const subsRes = await client
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth')
    .in('user_id', settingsRows.map((r) => r.user_id))
  if (subsRes.error) throw subsRes.error
  const subsByUser = new Map()
  for (const sub of subsRes.data || []) {
    if (!subsByUser.has(sub.user_id)) subsByUser.set(sub.user_id, [])
    subsByUser.get(sub.user_id).push(sub)
  }

  for (const row of settingsRows) {
    let subs = subsByUser.get(row.user_id) || []
    if (subs.length === 0) {
      summary.skipped += 1
      continue
    }
    summary.users += 1
    const leadMinutes = normalizeLeadMinutes(row.lead_minutes) ?? DEFAULT_LEAD_MINUTES
    const items = await loadDueCandidates(client, row.user_id, { now, leadMinutes })
    summary.checked += items.length

    for (const item of items) {
      if (summary.sent + summary.failed >= maxSends) break
      const claim = await client
        .from('push_deliveries')
        .insert({ user_id: row.user_id, item_key: item.key, kind: 'deadline', sent_at: now.toISOString() })
      if (claim.error) {
        if (claim.error.code === '23505') {
          summary.skipped += 1
          continue
        }
        throw claim.error
      }
      const payload = buildDeadlinePayload(item, now)
      for (const sub of subs) {
        const result = await send({
          subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          keys,
          topic: payload.tag,
          now: now.getTime(),
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
    }
  }
  return summary
}
