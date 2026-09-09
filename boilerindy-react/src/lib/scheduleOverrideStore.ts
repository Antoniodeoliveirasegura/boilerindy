/**
 * Client-side schedule corrections that survive ICS re-sync.
 * Keyed by backend user id (same pattern as task priorities).
 * Scraped meetings stay in the feed; we overlay edits/hides/manual classes
 * when building the weekly schedule view.
 */

export type ScheduleSeriesOverride = {
  code?: string
  name?: string
  room?: string
  /** "HH:mm" 24h local */
  startHm?: string
  /** "HH:mm" 24h local */
  endHm?: string
  /** If set, only keep meetings on these weekday names */
  days?: string[]
  hidden?: boolean
}

export type ManualClass = {
  id: string
  code: string
  name: string
  room: string
  days: string[]
  startHm: string
  endHm: string
}

export type ScheduleOverrideState = {
  series: Record<string, ScheduleSeriesOverride>
  manual: ManualClass[]
}

const EMPTY: ScheduleOverrideState = { series: {}, manual: [] }

function storageKey(userId: string): string {
  return `boilerindy-schedule-overrides-v1-${userId}`
}

function isHm(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value)
}

function normalizeHm(value: string): string {
  const [h, m] = value.split(':').map((n) => Number(n))
  if (!Number.isFinite(h) || !Number.isFinite(m)) return value
  return `${String(Math.min(23, Math.max(0, h))).padStart(2, '0')}:${String(Math.min(59, Math.max(0, m))).padStart(2, '0')}`
}

export function loadScheduleOverrides(userId: string | null | undefined): ScheduleOverrideState {
  if (!userId) return { series: {}, manual: [] }
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return { series: {}, manual: [] }
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { series: {}, manual: [] }

    const series: Record<string, ScheduleSeriesOverride> = {}
    if (parsed.series && typeof parsed.series === 'object') {
      for (const [key, value] of Object.entries(parsed.series as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue
        const v = value as ScheduleSeriesOverride
        const next: ScheduleSeriesOverride = {}
        if (typeof v.code === 'string') next.code = v.code
        if (typeof v.name === 'string') next.name = v.name
        if (typeof v.room === 'string') next.room = v.room
        if (isHm(v.startHm)) next.startHm = normalizeHm(v.startHm)
        if (isHm(v.endHm)) next.endHm = normalizeHm(v.endHm)
        if (Array.isArray(v.days)) {
          next.days = v.days.filter((d): d is string => typeof d === 'string')
        }
        if (v.hidden === true) next.hidden = true
        if (Object.keys(next).length) series[key] = next
      }
    }

    const manual: ManualClass[] = []
    if (Array.isArray(parsed.manual)) {
      for (const row of parsed.manual) {
        if (!row || typeof row !== 'object') continue
        const m = row as ManualClass
        if (typeof m.id !== 'string' || typeof m.code !== 'string') continue
        if (!isHm(m.startHm) || !isHm(m.endHm) || !Array.isArray(m.days)) continue
        manual.push({
          id: m.id,
          code: m.code,
          name: typeof m.name === 'string' ? m.name : 'Class meeting',
          room: typeof m.room === 'string' ? m.room : '',
          days: m.days.filter((d): d is string => typeof d === 'string'),
          startHm: normalizeHm(m.startHm),
          endHm: normalizeHm(m.endHm),
        })
      }
    }

    return { series, manual }
  } catch {
    return { series: {}, manual: [] }
  }
}

function persist(userId: string | null | undefined, state: ScheduleOverrideState): ScheduleOverrideState {
  if (userId) {
    try {
      localStorage.setItem(storageKey(userId), JSON.stringify(state))
    } catch {
      /* quota */
    }
  }
  return state
}

export function saveSeriesOverride(
  userId: string | null | undefined,
  seriesKey: string,
  patch: ScheduleSeriesOverride | null,
): ScheduleOverrideState {
  const current = loadScheduleOverrides(userId)
  const series = { ...current.series }
  if (!patch || Object.keys(patch).length === 0) {
    delete series[seriesKey]
  } else {
    const cleaned: ScheduleSeriesOverride = {}
    if (typeof patch.code === 'string') cleaned.code = patch.code.trim()
    if (typeof patch.name === 'string') cleaned.name = patch.name.trim()
    if (typeof patch.room === 'string') cleaned.room = patch.room.trim()
    if (isHm(patch.startHm)) cleaned.startHm = normalizeHm(patch.startHm)
    if (isHm(patch.endHm)) cleaned.endHm = normalizeHm(patch.endHm)
    if (Array.isArray(patch.days)) cleaned.days = patch.days.filter((d) => typeof d === 'string')
    if (patch.hidden === true) cleaned.hidden = true
    if (Object.keys(cleaned).length === 0) delete series[seriesKey]
    else series[seriesKey] = cleaned
  }
  return persist(userId, { ...current, series })
}

export function hideSeries(
  userId: string | null | undefined,
  seriesKey: string,
  hidden = true,
): ScheduleOverrideState {
  const current = loadScheduleOverrides(userId)
  const existing = current.series[seriesKey] || {}
  if (hidden) {
    return saveSeriesOverride(userId, seriesKey, { ...existing, hidden: true })
  }
  const { hidden: _drop, ...rest } = existing
  return saveSeriesOverride(userId, seriesKey, Object.keys(rest).length ? rest : null)
}

export function addManualClass(
  userId: string | null | undefined,
  entry: Omit<ManualClass, 'id'> & { id?: string },
): ScheduleOverrideState {
  const current = loadScheduleOverrides(userId)
  const row: ManualClass = {
    id: entry.id || `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    code: entry.code.trim() || 'CLASS',
    name: entry.name.trim() || 'Class meeting',
    room: entry.room.trim(),
    days: entry.days,
    startHm: normalizeHm(entry.startHm),
    endHm: normalizeHm(entry.endHm),
  }
  return persist(userId, { ...current, manual: [...current.manual, row] })
}

export function updateManualClass(
  userId: string | null | undefined,
  id: string,
  patch: Partial<Omit<ManualClass, 'id'>>,
): ScheduleOverrideState {
  const current = loadScheduleOverrides(userId)
  return persist(userId, {
    ...current,
    manual: current.manual.map((row) => {
      if (row.id !== id) return row
      return {
        ...row,
        code: typeof patch.code === 'string' ? patch.code.trim() || row.code : row.code,
        name: typeof patch.name === 'string' ? patch.name.trim() || row.name : row.name,
        room: typeof patch.room === 'string' ? patch.room.trim() : row.room,
        days: Array.isArray(patch.days) ? patch.days : row.days,
        startHm: isHm(patch.startHm) ? normalizeHm(patch.startHm) : row.startHm,
        endHm: isHm(patch.endHm) ? normalizeHm(patch.endHm) : row.endHm,
      }
    }),
  })
}

export function removeManualClass(
  userId: string | null | undefined,
  id: string,
): ScheduleOverrideState {
  const current = loadScheduleOverrides(userId)
  return persist(userId, {
    ...current,
    manual: current.manual.filter((row) => row.id !== id),
  })
}

export function isoToHm(iso: string | null | undefined): string {
  if (!iso) return '09:00'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '09:00'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function applyHmToIso(iso: string, hm: string): string {
  const d = new Date(iso)
  const [h, m] = normalizeHm(hm).split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

export function formatHmRange(startHm: string, endHm: string): string {
  const toLabel = (hm: string) => {
    const [h, m] = normalizeHm(hm).split(':').map(Number)
    const d = new Date()
    d.setHours(h, m, 0, 0)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return `${toLabel(startHm)} - ${toLabel(endHm)}`
}

export { EMPTY as EMPTY_SCHEDULE_OVERRIDES }
