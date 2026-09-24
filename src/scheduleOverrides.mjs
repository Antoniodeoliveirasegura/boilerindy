// Server-side mirror of boilerindy-react/src/lib/scheduleOverrideStore.ts.
//
// The client owns the editing UX; this module validates what it sends before it
// reaches the DB and replays the same edits onto raw calendar_items rows so the
// campus assistant sees the schedule the student actually sees. Without this the
// assistant talks about classes the student deleted and misses ones they added.
//
// Pure functions only - no DB, no HTTP - so they unit-test without a server.

export const MAX_SERIES_OVERRIDES = 200
export const MAX_MANUAL_CLASSES = 60

const WEEKDAYS = new Set([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
])

const HM_RE = /^\d{1,2}:\d{2}$/

function normalizeHm(value) {
  if (typeof value !== 'string' || !HM_RE.test(value)) return null
  const [h, m] = value.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  const hh = String(Math.min(23, Math.max(0, h))).padStart(2, '0')
  const mm = String(Math.min(59, Math.max(0, m))).padStart(2, '0')
  return `${hh}:${mm}`
}

function normalizeText(value, max) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function normalizeDays(value) {
  if (!Array.isArray(value)) return null
  const days = [...new Set(value.filter((d) => WEEKDAYS.has(d)))]
  return days.length ? days : null
}

/**
 * Coerce untrusted input into the stored override shape, dropping anything
 * malformed rather than rejecting the whole payload.
 * @returns {{ series: Record<string, object>, manual: object[] }}
 */
export function normalizeScheduleOverrides(raw) {
  const series = {}
  const manual = []
  if (!raw || typeof raw !== 'object') return { series, manual }

  if (raw.series && typeof raw.series === 'object' && !Array.isArray(raw.series)) {
    for (const [key, value] of Object.entries(raw.series)) {
      if (Object.keys(series).length >= MAX_SERIES_OVERRIDES) break
      if (typeof key !== 'string' || !key || key.length > 600) continue
      if (!value || typeof value !== 'object') continue

      const next = {}
      const code = normalizeText(value.code, 60)
      const name = normalizeText(value.name, 200)
      // room is intentionally allowed to be cleared to an empty string, so it is
      // read directly rather than through normalizeText (which drops blanks).
      const startHm = normalizeHm(value.startHm)
      const endHm = normalizeHm(value.endHm)
      const days = normalizeDays(value.days)

      if (code) next.code = code
      if (name) next.name = name
      if (typeof value.room === 'string') next.room = value.room.trim().slice(0, 200)
      if (startHm) next.startHm = startHm
      if (endHm) next.endHm = endHm
      if (days) next.days = days
      if (value.hidden === true) next.hidden = true

      if (Object.keys(next).length) series[key] = next
    }
  }

  if (Array.isArray(raw.manual)) {
    for (const row of raw.manual) {
      if (manual.length >= MAX_MANUAL_CLASSES) break
      if (!row || typeof row !== 'object') continue
      const id = normalizeText(row.id, 100)
      const code = normalizeText(row.code, 60)
      const startHm = normalizeHm(row.startHm)
      const endHm = normalizeHm(row.endHm)
      const days = normalizeDays(row.days)
      if (!id || !code || !startHm || !endHm || !days) continue
      manual.push({
        id,
        code,
        name: normalizeText(row.name, 200) || 'Class meeting',
        room: typeof row.room === 'string' ? row.room.trim().slice(0, 200) : '',
        days,
        startHm,
        endHm,
      })
    }
  }

  return { series, manual }
}

/**
 * Stable key for a scraped meeting series. Must stay byte-identical to
 * classSeriesKey() in scheduleOverrideStore.ts or edits will not line up.
 */
export function classSeriesKeyFromRow(row) {
  const title = row?.title ?? ''
  const description = row?.description ?? ''
  const location = row?.location ?? ''
  return [title, description, location].join('|')
}

function zonedParts(date, timeZone) {
  const parts = {}
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return parts
}

/** Minutes east of UTC for `date` in `timeZone`. */
function zoneOffsetMinutes(date, timeZone) {
  const p = zonedParts(date, timeZone)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return (asUtc - date.getTime()) / 60000
}

export function weekdayInZone(date, timeZone) {
  return new Date(date).toLocaleDateString('en-US', { timeZone, weekday: 'long' })
}

/**
 * Move an instant to a different wall-clock time on the same calendar day in
 * `timeZone`. Mirrors applyHmToIso() on the client, which uses browser-local
 * time; here the campus timezone is authoritative.
 */
export function applyHmInZone(iso, hm, timeZone) {
  const base = new Date(iso)
  const normalized = normalizeHm(hm)
  if (!normalized || Number.isNaN(base.getTime())) return iso
  const p = zonedParts(base, timeZone)
  const [h, m] = normalized.split(':').map(Number)
  const offset = zoneOffsetMinutes(base, timeZone)
  const utcMs = Date.UTC(+p.year, +p.month - 1, +p.day, h, m, 0) - offset * 60000
  return new Date(utcMs).toISOString()
}

/**
 * Replay the student's edits onto raw calendar_items rows (snake_case).
 * Hidden series drop out; edited fields and times are rewritten in place.
 */
export function applyScheduleOverridesToRows(rows, overrides, timeZone) {
  const series = overrides?.series || {}
  if (!rows?.length) return []
  const out = []

  for (const row of rows) {
    // Overrides are authored against class meetings only; leave deadlines and
    // events untouched even if a key happens to collide.
    if (row.category !== 'class') {
      out.push(row)
      continue
    }

    const override = series[classSeriesKeyFromRow(row)]
    if (!override) {
      out.push(row)
      continue
    }
    if (override.hidden) continue

    if (override.days?.length && row.start_time) {
      if (!override.days.includes(weekdayInZone(row.start_time, timeZone))) continue
    }

    const next = { ...row }
    if (override.code != null) next.title = override.code
    if (override.name != null) next.description = override.name
    if (override.room != null) next.location = override.room
    if (override.startHm && row.start_time) {
      next.start_time = applyHmInZone(row.start_time, override.startHm, timeZone)
    }
    if (override.endHm) {
      const base = row.end_time || row.start_time
      if (base) next.end_time = applyHmInZone(base, override.endHm, timeZone)
    }
    out.push(next)
  }

  return out
}

/**
 * Expand manually added weekly classes into dated rows across [from, to] so they
 * appear in the assistant's context alongside synced meetings.
 */
export function manualClassesAsRows(manual, from, to, timeZone) {
  if (!manual?.length) return []
  const rows = []
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)
  const end = new Date(to)

  // Day-by-day rather than week-by-week so DST shifts and partial weeks are
  // handled by the same zone-aware conversion as everything else.
  for (let guard = 0; cursor <= end && guard < 90; guard += 1) {
    const dayName = weekdayInZone(cursor, timeZone)
    for (const entry of manual) {
      if (!entry.days.includes(dayName)) continue
      const startIso = applyHmInZone(cursor.toISOString(), entry.startHm, timeZone)
      const endIso = applyHmInZone(cursor.toISOString(), entry.endHm, timeZone)
      if (new Date(startIso) < new Date(from) || new Date(startIso) > end) continue
      rows.push({
        id: `manual-${entry.id}-${startIso}`,
        title: entry.code,
        description: entry.name,
        location: entry.room || '',
        start_time: startIso,
        end_time: endIso,
        category: 'class',
        manual: true,
      })
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return rows
}
