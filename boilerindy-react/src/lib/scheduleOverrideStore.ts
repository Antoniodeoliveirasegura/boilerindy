/**
 * Schedule corrections that survive ICS re-sync: hidden series, edited details
 * and manually added class blocks. Scraped meetings stay in the feed; we overlay
 * the edits when building the weekly schedule view.
 *
 * localStorage stays the read path so every call site can stay synchronous and
 * renders never flicker, but the state is mirrored to the server so it follows
 * the student across devices and the campus assistant can see it. Reads and
 * writes are keyed by backend user id.
 */

import { useEffect, useState } from 'react'
import { authRequest } from './authApi'

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

/**
 * Weekdays the Schedule editor can show a checkbox for. A day override narrows
 * this set; it must never silently drop a meeting outside it (e.g. a Saturday
 * lab), because the student was never offered a box to keep it.
 */
const EDITABLE_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

/**
 * Weekday name in English. DAYS/EDITABLE_DAYS are hardcoded English, so the
 * lookup must not follow the browser locale or every comparison fails.
 */
function weekdayName(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long' })
}

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

/** Validate an untrusted override document (localStorage or API) into state. */
function coerceOverrideState(parsed: unknown): ScheduleOverrideState {
  if (typeof parsed !== 'object' || parsed === null) return { series: {}, manual: [] }
  const raw = parsed as { series?: unknown; manual?: unknown }

  const series: Record<string, ScheduleSeriesOverride> = {}
  if (raw.series && typeof raw.series === 'object') {
    for (const [key, value] of Object.entries(raw.series as Record<string, unknown>)) {
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
  if (Array.isArray(raw.manual)) {
    for (const row of raw.manual) {
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
}

export function loadScheduleOverrides(userId: string | null | undefined): ScheduleOverrideState {
  if (!userId) return { series: {}, manual: [] }
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return { series: {}, manual: [] }
    return coerceOverrideState(JSON.parse(raw))
  } catch {
    return { series: {}, manual: [] }
  }
}

/** Fires whenever overrides change locally or a server pull lands. */
export const SCHEDULE_OVERRIDES_EVENT = 'boilerindy-schedule-overrides-changed'

function writeLocal(userId: string, state: ScheduleOverrideState): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(state))
  } catch {
    /* quota */
  }
}

// Survives reloads: set the moment an edit is made and cleared only once the
// server has acknowledged that exact state. Without it, an upload that failed
// (offline, 500, tab closed mid-flight) would be silently overwritten by the
// server copy on the next sync, losing the student's corrections.
function dirtyKey(userId: string): string {
  return `boilerindy-schedule-overrides-dirty-v1-${userId}`
}

function markDirty(userId: string): void {
  try {
    localStorage.setItem(dirtyKey(userId), '1')
  } catch {
    /* quota */
  }
}

function clearDirty(userId: string): void {
  try {
    localStorage.removeItem(dirtyKey(userId))
  } catch {
    /* ignore */
  }
}

function hasUnsyncedEdits(userId: string): boolean {
  if (pushTimers.has(userId)) return true
  try {
    return localStorage.getItem(dirtyKey(userId)) === '1'
  } catch {
    return false
  }
}

// Edits arrive in bursts (typing a room name, toggling days), so the upload is
// debounced and only the newest state is sent.
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>()

function schedulePush(userId: string, state: ScheduleOverrideState): void {
  markDirty(userId)
  const existing = pushTimers.get(userId)
  if (existing) clearTimeout(existing)
  const payload = JSON.stringify({ overrides: state })
  pushTimers.set(
    userId,
    setTimeout(() => {
      pushTimers.delete(userId)
      authRequest('/api/me/schedule-overrides', { method: 'PUT', body: payload })
        .then(() => {
          // A newer edit may have queued while this was in flight; that push
          // owns the flag now, so leave it set.
          if (!pushTimers.has(userId)) clearDirty(userId)
        })
        // localStorage still holds the truth for this device and the dirty flag
        // makes the next page load retry, so a failure is not fatal.
        .catch(() => {})
    }, 600),
  )
}

function persist(userId: string | null | undefined, state: ScheduleOverrideState): ScheduleOverrideState {
  if (userId) {
    writeLocal(userId, state)
    schedulePush(userId, state)
    window.dispatchEvent(new Event(SCHEDULE_OVERRIDES_EVENT))
  }
  return state
}

function isEmptyState(state: ScheduleOverrideState): boolean {
  return Object.keys(state.series).length === 0 && state.manual.length === 0
}

/**
 * Reconcile this device with the server once per session.
 *
 * Whoever has data wins: a fresh device adopts the server copy, and a device
 * that still has pre-migration localStorage edits uploads them. When both sides
 * have data the server wins, since it is the shared copy.
 */
export async function syncScheduleOverridesFromServer(
  userId: string | null | undefined,
): Promise<ScheduleOverrideState> {
  const before = loadScheduleOverrides(userId)
  if (!userId) return before

  try {
    const data = (await authRequest('/api/me/schedule-overrides')) as {
      overrides?: unknown
      unavailable?: boolean
    }
    if (data.unavailable) return before

    // The student can edit while this request is in flight. Re-read rather than
    // trusting the snapshot, or the response would overwrite a newer local edit.
    const local = loadScheduleOverrides(userId)
    const localChangedDuringFetch = JSON.stringify(local) !== JSON.stringify(before)

    if (hasUnsyncedEdits(userId) || localChangedDuringFetch) {
      // schedulePush replaces any queued payload, so pass the newest state.
      schedulePush(userId, local)
      return local
    }

    const remote = coerceOverrideState(data.overrides)
    if (isEmptyState(remote) && !isEmptyState(local)) {
      schedulePush(userId, local)
      return local
    }

    writeLocal(userId, remote)
    window.dispatchEvent(new Event(SCHEDULE_OVERRIDES_EVENT))
    return remote
  } catch {
    return loadScheduleOverrides(userId)
  }
}

/**
 * Overrides for the current user, kept current as edits land on any page and
 * after the initial server pull.
 */
export function useScheduleOverrides(userId: string | null | undefined): ScheduleOverrideState {
  const [state, setState] = useState<ScheduleOverrideState>(() => loadScheduleOverrides(userId))

  useEffect(() => {
    setState(loadScheduleOverrides(userId))
    const onChange = () => setState(loadScheduleOverrides(userId))
    window.addEventListener(SCHEDULE_OVERRIDES_EVENT, onChange)
    return () => window.removeEventListener(SCHEDULE_OVERRIDES_EVENT, onChange)
  }, [userId])

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

/** Stable key for a scraped meeting series (must match Schedule page grouping). */
export function classSeriesKey(item: {
  title?: string | null
  description?: string | null
  location?: string | null
}): string {
  return [item.title || '', item.description || '', item.location || ''].join('|')
}

type OverridableClassItem = {
  title?: string
  description?: string
  location?: string
  startTime?: string
  endTime?: string | null
  [key: string]: unknown
}

/**
 * Apply schedule edits/deletes to raw class rows so Home and Schedule stay in sync.
 * Hidden series are dropped; field/time/day overrides are applied in place.
 */
export function applyScheduleOverridesToItems<T extends OverridableClassItem>(
  items: T[] | null | undefined,
  overrides: ScheduleOverrideState,
): T[] {
  const out: T[] = []
  for (const item of items || []) {
    const key = classSeriesKey(item)
    const override = overrides.series[key]
    if (override?.hidden) continue

    if (override?.days?.length && item.startTime) {
      const day = weekdayName(new Date(item.startTime))
      if (EDITABLE_DAYS.includes(day) && !override.days.includes(day)) continue
    }

    if (!override) {
      out.push(item)
      continue
    }

    const next: T = { ...item }
    if (override.code != null) next.title = override.code
    if (override.name != null) next.description = override.name
    if (override.room != null) next.location = override.room
    if (override.startHm && item.startTime) {
      next.startTime = applyHmToIso(item.startTime, override.startHm)
    }
    if (override.endHm) {
      const base = item.endTime || item.startTime
      if (base) next.endTime = applyHmToIso(base, override.endHm)
    }
    out.push(next)
  }
  return out
}

/** Turn manual schedule classes into dated items for a given calendar day (Home today strip). */
export function manualClassesAsItems(
  manual: ManualClass[],
  dayDate: Date = new Date(),
): OverridableClassItem[] {
  const dayName = weekdayName(dayDate)
  return (manual || [])
    .filter((row) => row.days.includes(dayName))
    .map((row) => {
      const anchor = new Date(dayDate)
      return {
        id: `manual-${row.id}`,
        title: row.code,
        description: row.name,
        location: row.room || 'Location unavailable',
        startTime: applyHmToIso(anchor.toISOString(), row.startHm),
        endTime: applyHmToIso(anchor.toISOString(), row.endHm),
      }
    })
}

export { EMPTY as EMPTY_SCHEDULE_OVERRIDES }
