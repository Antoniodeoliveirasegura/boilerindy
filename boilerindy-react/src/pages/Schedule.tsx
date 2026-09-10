import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { extractBuildingCode } from '../lib/buildingCode'
import Icon from '../components/Icons'
import { filterClassItemsForSchedulePage } from '../lib/scheduleFilters'
import {
  addManualClass,
  applyHmToIso,
  formatHmRange,
  hideSeries,
  isoToHm,
  loadScheduleOverrides,
  removeManualClass,
  saveSeriesOverride,
  updateManualClass,
  type ScheduleOverrideState,
  type ScheduleSeriesOverride,
} from '../lib/scheduleOverrideStore'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const DAY_CODES: Record<string, string> = {
  Monday: 'M',
  Tuesday: 'T',
  Wednesday: 'W',
  Thursday: 'Th',
  Friday: 'F',
}

type ClassItem = {
  id?: string
  title?: string
  description?: string
  location?: string
  startTime?: string
  endTime?: string | null
}

type ClassEntry = {
  id: string
  seriesKey: string
  day: string
  code: string
  name: string
  time: string
  room: string
  startTime: string
  endTime?: string | null
  color: string
  count: number
  pattern?: string
  isManual?: boolean
  manualId?: string
  hasOverride?: boolean
}

type EditForm = {
  code: string
  name: string
  room: string
  startHm: string
  endHm: string
  days: string[]
}

const colorOrder = ['blue', 'green', 'purple', 'orange']
const colorConfig: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  blue: {
    bg: 'bg-[#e4eef8] dark:bg-[#18283a]',
    border: 'border-[#6c8fb3]/18 dark:border-[#4f78a4]/30',
    text: 'text-[#37628d] dark:text-[#8fc4ff]',
    accent: 'bg-[#4f78a4] dark:bg-[#4f78a4]',
  },
  green: {
    bg: 'bg-[#e3f1e7] dark:bg-[#112b19]',
    border: 'border-[#5a9470]/18 dark:border-[#3f9a59]/30',
    text: 'text-[#2f6d47] dark:text-[#72d493]',
    accent: 'bg-[#3f9a59] dark:bg-[#3f9a59]',
  },
  purple: {
    bg: 'bg-[#efe8f5] dark:bg-[#26183a]',
    border: 'border-[#8d6aa7]/18 dark:border-[#9b72bd]/30',
    text: 'text-[#76548f] dark:text-[#d8b6ff]',
    accent: 'bg-[#8d6aa7] dark:bg-[#9b72bd]',
  },
  orange: {
    bg: 'bg-[#f5ead8] dark:bg-[#332208]',
    border: 'border-[#a98542]/18 dark:border-[#b98a2a]/30',
    text: 'text-[#7a5720] dark:text-[#f0c56a]',
    accent: 'bg-[#a98542] dark:bg-[#b98a2a]',
  },
}

function getDayName(dateValue: string | Date) {
  // 'en-US' on purpose: DAYS and DAY_CODES below are English, so a browser set
  // to another locale would return "lunes" and match nothing.
  return new Date(dateValue).toLocaleDateString('en-US', { weekday: 'long' })
}

function getTimeRange(startTime: string, endTime: string | null | undefined) {
  const start = new Date(startTime)
  const end = endTime ? new Date(endTime) : null
  const startLabel = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const endLabel = end ? end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  return endLabel ? `${startLabel} - ${endLabel}` : startLabel
}

function getPatternLabel(days: string[]) {
  const normalized = [...new Set(days)].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b))
  const compact = normalized.map((day) => DAY_CODES[day] || day.slice(0, 1)).join('')

  const knownPatterns: Record<string, string> = {
    MWF: 'MWF',
    MW: 'MW',
    MF: 'MF',
    WF: 'WF',
    TTh: 'TTh',
    T: 'T',
    Th: 'Th',
    W: 'W',
    F: 'F',
    MTWThF: 'MTWThF',
  }

  return knownPatterns[compact] || compact
}

function makeSeriesKey(item: Pick<ClassItem, 'title' | 'description' | 'location'>) {
  return [item.title || '', item.description || '', item.location || ''].join('|')
}

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

function emptySchedule(): Record<string, ClassEntry[]> {
  return Object.fromEntries(DAYS.map((day) => [day, [] as ClassEntry[]]))
}

function getWeeklyPattern(
  items: ClassItem[],
  overrides: ScheduleOverrideState,
): Record<string, ClassEntry[]> {
  const seen = new Map<string, ClassEntry>()
  const seriesDays = new Map<string, Set<string>>()

  for (const item of items) {
    if (!item.startTime) continue
    const seriesKey = makeSeriesKey(item)
    const override = overrides.series[seriesKey]
    if (override?.hidden) continue

    const day = getDayName(item.startTime)
    if (!DAYS.includes(day)) continue
    if (override?.days?.length && !override.days.includes(day)) continue

    const code = override?.code ?? item.title ?? ''
    const name = override?.name ?? item.description ?? 'Class meeting'
    const room = override?.room ?? item.location ?? 'Location unavailable'
    const startTime = override?.startHm ? applyHmToIso(item.startTime, override.startHm) : item.startTime
    const endTime = override?.endHm
      ? applyHmToIso(item.endTime || item.startTime, override.endHm)
      : item.endTime

    const start = new Date(startTime)
    const end = endTime ? new Date(endTime) : null
    const key = [
      day,
      seriesKey,
      start.getHours(),
      start.getMinutes(),
      end?.getHours() || '',
      end?.getMinutes() || '',
    ].join('|')

    const existingDays = seriesDays.get(seriesKey) || new Set()
    existingDays.add(day)
    seriesDays.set(seriesKey, existingDays)

    const hasOverride = Boolean(
      override &&
        (override.code != null ||
          override.name != null ||
          override.room != null ||
          override.startHm != null ||
          override.endHm != null ||
          (override.days && override.days.length > 0)),
    )

    if (!seen.has(key)) {
      seen.set(key, {
        id: key,
        seriesKey,
        day,
        code,
        name,
        time: getTimeRange(startTime, endTime),
        room: room || 'Location unavailable',
        startTime,
        endTime,
        color: colorOrder[seen.size % colorOrder.length],
        count: 1,
        hasOverride,
      })
    } else {
      seen.get(key)!.count += 1
    }
  }

  const grouped = emptySchedule()
  for (const item of seen.values()) {
    grouped[item.day].push({
      ...item,
      pattern: getPatternLabel([...(seriesDays.get(item.seriesKey) || [item.day])]),
    })
  }

  let colorCursor = seen.size
  for (const manual of overrides.manual) {
    const pattern = getPatternLabel(manual.days.filter((d) => DAYS.includes(d)))
    for (const day of manual.days) {
      if (!DAYS.includes(day)) continue
      // Anchor ISO to a representative weekday so sorting stays stable for this day.
      const dayIndex = DAYS.indexOf(day)
      const anchor = new Date()
      const delta = dayIndex - ((anchor.getDay() + 6) % 7)
      anchor.setDate(anchor.getDate() + delta)
      const anchoredStart = applyHmToIso(anchor.toISOString(), manual.startHm)
      const anchoredEnd = applyHmToIso(anchor.toISOString(), manual.endHm)
      grouped[day].push({
        id: `manual|${manual.id}|${day}`,
        seriesKey: `manual|${manual.id}`,
        day,
        code: manual.code,
        name: manual.name,
        time: formatHmRange(manual.startHm, manual.endHm),
        room: manual.room || 'Location unavailable',
        startTime: anchoredStart,
        endTime: anchoredEnd,
        color: colorOrder[colorCursor++ % colorOrder.length],
        count: 1,
        pattern,
        isManual: true,
        manualId: manual.id,
        hasOverride: true,
      })
    }
  }

  for (const day of DAYS) {
    grouped[day].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  }

  return grouped
}

function daysFromEntry(schedule: Record<string, ClassEntry[]>, seriesKey: string): string[] {
  return DAYS.filter((day) => (schedule[day] || []).some((c) => c.seriesKey === seriesKey))
}

export default function Schedule() {
  const { user, onboarding } = useAuth()
  const userId = user?.id as string | undefined
  const navigate = useNavigate()
  const [selectedDay, setSelectedDay] = useState(() => {
    const today = getDayName(new Date())
    return DAYS.includes(today) ? today : 'Monday'
  })
  const [selectedClass, setSelectedClass] = useState<ClassEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [banner, setBanner] = useState('')
  const [termLabel, setTermLabel] = useState('')
  const [classesMeta, setClassesMeta] = useState<{ totalInTerm?: number }>({ totalInTerm: 0 })
  const [classItems, setClassItems] = useState<ClassItem[]>([])
  const [overrides, setOverrides] = useState<ScheduleOverrideState>(() => loadScheduleOverrides(userId))
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<EditForm>({
    code: '',
    name: '',
    room: '',
    startHm: '10:30',
    endHm: '11:20',
    days: ['Monday'],
  })
  const [formError, setFormError] = useState('')

  const handleFindRoom = (room: string) => {
    const buildingCode = extractBuildingCode(room)
    if (buildingCode) {
      navigate(`/map?building=${buildingCode}&room=${encodeURIComponent(room)}`)
    } else {
      navigate(`/map?room=${encodeURIComponent(room)}`)
    }
  }

  useEffect(() => {
    setOverrides(loadScheduleOverrides(userId))
  }, [userId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setBanner('')
      try {
        const response = (await authRequest('/api/me/classes?limit=500&mode=chronological')) as {
          items?: ClassItem[]
          meta?: { totalInTerm?: number; selectedTermLabel?: string }
        }
        if (cancelled) return
        setClassItems(response.items || [])
        setClassesMeta(response.meta || { totalInTerm: 0 })
        setTermLabel(response.meta?.selectedTermLabel || '')
      } catch (error) {
        if (!cancelled) {
          setBanner(error instanceof Error ? error.message : 'Could not load your class schedule.')
          setClassItems([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const scheduleClassItems = useMemo(
    () => filterClassItemsForSchedulePage(classItems),
    [classItems],
  )
  const placeholderHiddenCount = classItems.length - scheduleClassItems.length
  const schedule = useMemo(
    () => getWeeklyPattern(scheduleClassItems, overrides),
    [scheduleClassItems, overrides],
  )
  const classes = useMemo(() => schedule[selectedDay] || [], [schedule, selectedDay])
  const hiddenCount = useMemo(
    () => Object.values(overrides.series).filter((o) => o.hidden).length,
    [overrides],
  )

  const [prevClasses, setPrevClasses] = useState<ClassEntry[] | null>(null)
  if (classes !== prevClasses) {
    setPrevClasses(classes)
    if (!classes.length) {
      setSelectedClass(null)
    } else {
      setSelectedClass((current) =>
        current && classes.some((item) => item.id === current.id) ? current : classes[0],
      )
    }
  }

  const needsSetup = onboarding?.needsPurdueConnection || onboarding?.needsScheduleSource

  function requireUser(): string | null {
    if (!userId) {
      setBanner('Sign in to edit your schedule.')
      return null
    }
    return userId
  }

  function openEdit(cls: ClassEntry) {
    setAdding(false)
    setEditing(true)
    setFormError('')
    setForm({
      code: cls.code,
      name: cls.name,
      room: cls.room === 'Location unavailable' ? '' : cls.room,
      startHm: isoToHm(cls.startTime),
      endHm: isoToHm(cls.endTime || cls.startTime),
      days: cls.isManual && cls.manualId
        ? overrides.manual.find((m) => m.id === cls.manualId)?.days || [cls.day]
        : daysFromEntry(schedule, cls.seriesKey),
    })
  }

  function openAdd() {
    setEditing(false)
    setAdding(true)
    setFormError('')
    setForm({
      code: '',
      name: '',
      room: '',
      startHm: '10:30',
      endHm: '11:20',
      days: [selectedDay],
    })
  }

  function toggleDay(day: string) {
    setForm((prev) => {
      const has = prev.days.includes(day)
      if (has && prev.days.length === 1) return prev
      return {
        ...prev,
        days: has ? prev.days.filter((d) => d !== day) : [...prev.days, day],
      }
    })
  }

  /** Returns the first problem with the editor form, or '' when it is valid. */
  function validateForm(): string {
    if (!form.code.trim()) return 'Course code is required.'
    if (!form.days.length) return 'Pick at least one day.'
    if (hmToMinutes(form.endHm) <= hmToMinutes(form.startHm)) {
      return 'End time must be after the start time.'
    }
    return ''
  }

  function saveEdit() {
    const uid = requireUser()
    if (!uid || !selectedClass) return
    const invalid = validateForm()
    if (invalid) {
      setFormError(invalid)
      return
    }

    if (selectedClass.isManual && selectedClass.manualId) {
      setOverrides(
        updateManualClass(uid, selectedClass.manualId, {
          code: form.code,
          name: form.name,
          room: form.room,
          startHm: form.startHm,
          endHm: form.endHm,
          days: form.days,
        }),
      )
    } else {
      const patch: ScheduleSeriesOverride = {
        code: form.code.trim(),
        name: form.name.trim() || 'Class meeting',
        room: form.room.trim(),
        startHm: form.startHm,
        endHm: form.endHm,
        days: form.days,
      }
      setOverrides(saveSeriesOverride(uid, selectedClass.seriesKey, patch))
    }
    setEditing(false)
    setBanner('Schedule updated on this device. Your edits stay even if you re-sync the feed.')
  }

  function saveAdd() {
    const uid = requireUser()
    if (!uid) return
    const invalid = validateForm()
    if (invalid) {
      setFormError(invalid)
      return
    }
    const next = addManualClass(uid, {
      code: form.code,
      name: form.name,
      room: form.room,
      startHm: form.startHm,
      endHm: form.endHm,
      days: form.days,
    })
    setOverrides(next)
    setAdding(false)
    setSelectedDay(form.days[0])
    setBanner('Class added to your schedule.')
  }

  function handleHide(cls: ClassEntry) {
    const uid = requireUser()
    if (!uid) return
    if (cls.isManual && cls.manualId) {
      setOverrides(removeManualClass(uid, cls.manualId))
      setSelectedClass(null)
      setEditing(false)
      setBanner('Deleted that class from your schedule.')
      return
    }
    setOverrides(hideSeries(uid, cls.seriesKey, true))
    setSelectedClass(null)
    setEditing(false)
    setBanner('Deleted from your schedule. Re-sync will not bring it back - use Restore if you change your mind.')
  }

  function handleReset(cls: ClassEntry) {
    const uid = requireUser()
    if (!uid) return
    if (cls.isManual && cls.manualId) {
      setOverrides(removeManualClass(uid, cls.manualId))
      setSelectedClass(null)
      setEditing(false)
      setBanner('Removed that added class.')
      return
    }
    setOverrides(saveSeriesOverride(uid, cls.seriesKey, null))
    setEditing(false)
    setBanner('Restored the imported values for that class.')
  }

  function restoreHidden() {
    const uid = requireUser()
    if (!uid) return
    let next = loadScheduleOverrides(uid)
    for (const [key, value] of Object.entries(next.series)) {
      if (!value.hidden) continue
      const { hidden: _h, ...rest } = value
      next = saveSeriesOverride(uid, key, Object.keys(rest).length ? rest : null)
    }
    setOverrides(next)
    setBanner('Restored hidden imported classes.')
  }

  const editorOpen = editing || adding

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-8 pb-24 transition-opacity duration-500 opacity-100">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6 animate-fade-in-up">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Class Schedule</h1>
          <p className="text-[14px] text-[var(--color-txt-2)] mt-1">
            {termLabel || 'Current term'}
            {classesMeta.totalInTerm ? ` · ${classesMeta.totalInTerm} imported meetings` : ''}
            {placeholderHiddenCount > 0 ? (
              <span className="text-[var(--color-txt-3)]">
                {' '}
                · {placeholderHiddenCount} placeholder{placeholderHiddenCount !== 1 ? 's' : ''} hidden (online shells / exams in feed)
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={restoreHidden}
              className="btn btn-secondary text-[13px] px-4 py-2.5"
            >
              Restore {hiddenCount} deleted
            </button>
          ) : null}
          <button type="button" onClick={openAdd} className="btn btn-primary text-[13px] px-4 py-2.5">
            <Icon name="plus" size={14} />
            Add class
          </button>
        </div>
      </div>

      {banner && (
        <div className="card p-4 mb-6 text-[13px] text-[var(--color-txt-1)] border-[var(--color-border)]">
          {banner}
        </div>
      )}

      {needsSetup && (
        <div className="card p-5 mb-6 border-[var(--color-gold)]/30 bg-[var(--color-gold)]/8 animate-fade-in-up">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="text-[16px] font-semibold text-[var(--color-txt-0)]">
                {onboarding?.needsPurdueConnection ? 'Link Purdue to import your schedule' : 'Connect your Purdue timetable feed'}
              </div>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-1 max-w-[640px]">
                {onboarding?.needsPurdueConnection
                  ? 'Your BoilerIndy account is ready. Link Purdue first, then attach your timetable iCal export.'
                  : 'Your Purdue account is linked. Finish setup to sync your recurring class meetings into this page.'}
              </p>
            </div>
            <Link to="/setup" className="btn btn-primary text-[13px] px-5 py-2.5 w-fit">
              <Icon name={onboarding?.needsPurdueConnection ? 'graduation' : 'calendar'} size={15} />
              Open setup
            </Link>
          </div>
        </div>
      )}

      {editorOpen ? (
        <div className="card p-5 mb-6 animate-fade-in-up">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-[16px] font-semibold text-[var(--color-txt-0)]">
                {adding ? 'Add a class' : 'Edit class'}
              </h2>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-1">
                Fixes stay on this device and keep working after you re-sync the Purdue feed.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setAdding(false)
                setFormError('')
              }}
              className="text-[var(--color-txt-3)] hover:text-[var(--color-txt-1)]"
              aria-label="Close editor"
            >
              <Icon name="close" size={18} />
            </button>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block text-[12px] text-[var(--color-txt-3)]">
              Course code
              <input
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-txt-0)]"
                placeholder="CS 18000"
              />
            </label>
            <label className="block text-[12px] text-[var(--color-txt-3)]">
              Name / section
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-txt-0)]"
                placeholder="Problem Solving And Object-Oriented Programming"
              />
            </label>
            <label className="block text-[12px] text-[var(--color-txt-3)]">
              Room / location
              <input
                value={form.room}
                onChange={(e) => setForm((f) => ({ ...f, room: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-txt-0)]"
                placeholder="LWSN B155"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-[12px] text-[var(--color-txt-3)]">
                Starts
                <input
                  type="time"
                  value={form.startHm}
                  onChange={(e) => setForm((f) => ({ ...f, startHm: e.target.value }))}
                  className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-txt-0)]"
                />
              </label>
              <label className="block text-[12px] text-[var(--color-txt-3)]">
                Ends
                <input
                  type="time"
                  value={form.endHm}
                  onChange={(e) => setForm((f) => ({ ...f, endHm: e.target.value }))}
                  className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-txt-0)]"
                />
              </label>
            </div>
          </div>

          <div className="mt-4">
            <div className="text-[12px] text-[var(--color-txt-3)] mb-2">Meets on</div>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((day) => {
                const active = form.days.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(day)}
                    className={`text-[12px] px-3 py-1.5 rounded-xl border transition-colors ${
                      active
                        ? 'border-[var(--color-gold)] bg-[var(--color-gold)]/15 text-[var(--color-txt-0)]'
                        : 'border-[var(--color-border)] text-[var(--color-txt-2)]'
                    }`}
                  >
                    {day.slice(0, 3)}
                  </button>
                )
              })}
            </div>
            {!adding && !selectedClass?.isManual ? (
              <p className="text-[11px] text-[var(--color-txt-3)] mt-2">
                Uncheck a day to hide that meeting if the feed put it on the wrong weekday.
              </p>
            ) : null}
          </div>

          {formError ? (
            <p className="text-[13px] text-red-600 dark:text-red-400 mt-3">{formError}</p>
          ) : null}

          <div className="flex flex-wrap gap-2 mt-5">
            <button
              type="button"
              onClick={adding ? saveAdd : saveEdit}
              className="btn btn-primary text-[13px] px-4 py-2.5"
            >
              {adding ? 'Add to schedule' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setAdding(false)
                setFormError('')
              }}
              className="btn btn-secondary text-[13px] px-4 py-2.5"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* Weekday strip scrolls inside the card on narrow screens (issue #162);
          the day buttons keep their minimum width instead of compressing. */}
      <div className="card p-1.5 mb-6 animate-fade-in-up stagger-1">
        <div className="flex gap-1 overflow-x-auto">
          {DAYS.map((day) => {
            const isSelected = selectedDay === day
            const hasClasses = (schedule[day] || []).length > 0
            return (
              <button
                key={day}
                onClick={() => setSelectedDay(day)}
                className={`flex-1 shrink-0 min-w-[88px] whitespace-nowrap text-[13px] py-2.5 rounded-xl transition-all duration-300 relative
                  ${isSelected
                    ? 'bg-gradient-to-r from-[var(--color-gold)] to-[var(--color-gold-light)] text-[var(--color-gold-dark)] font-semibold shadow-sm'
                    : 'text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)]'
                  }`}
              >
                <span className="hidden sm:inline">{day}</span>
                <span className="sm:hidden">{day.slice(0, 3)}</span>
                {hasClasses && !isSelected && (
                  <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[var(--color-gold)]" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_340px] gap-6">
        <div className="space-y-3 animate-fade-in-up stagger-2">
          {loading ? (
            <div className="card p-12 text-center">
              <p className="text-[15px] font-medium text-[var(--color-txt-1)]">Loading imported classes…</p>
            </div>
          ) : classes.length === 0 ? (
            <div className="card p-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-[var(--color-stat)] flex items-center justify-center mx-auto mb-4">
                <Icon name="calendar" size={28} className="text-[var(--color-txt-3)]" />
              </div>
              <p className="text-[15px] font-medium text-[var(--color-txt-1)]">No weekly classes scheduled</p>
              <p className="text-[13px] text-[var(--color-txt-3)] mt-1">
                {needsSetup
                  ? 'Finish setup to populate this schedule, or add a class manually.'
                  : 'No recurring class meetings were found for this day. Add one if the feed missed it.'}
              </p>
              <button type="button" onClick={openAdd} className="btn btn-secondary text-[13px] px-4 py-2.5 mt-4">
                Add class
              </button>
            </div>
          ) : (
            classes.map((cls, idx) => {
              const config = colorConfig[cls.color]
              const isSelected = selectedClass?.id === cls.id

              return (
                <div
                  key={cls.id}
                  onClick={() => setSelectedClass(cls)}
                  className={`card card-interactive p-0 overflow-hidden transition-all duration-300
                    ${isSelected ? 'ring-2 ring-[var(--color-gold)] ring-offset-2 ring-offset-[var(--color-bg-1)]' : ''}`}
                  style={{ animationDelay: `${idx * 0.08}s` }}
                >
                  <div className="flex">
                    <div className={`w-1.5 ${config.accent}`} />
                    <div className={`flex-1 p-4 ${config.bg} ${config.border} border-l-0 border`}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className={`text-[11px] font-semibold ${config.text} tracking-wide`}>
                              {cls.code}
                            </div>
                            <span className="badge">{cls.pattern}</span>
                            {cls.isManual ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--color-stat)] text-[var(--color-txt-2)]">
                                Added
                              </span>
                            ) : null}
                            {cls.hasOverride && !cls.isManual ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--color-gold)]/20 text-[var(--color-txt-1)]">
                                Edited
                              </span>
                            ) : null}
                          </div>
                          <div className="text-[16px] font-semibold text-[var(--color-txt-0)] mt-1">
                            {cls.name}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--color-txt-2)] mt-2">
                            <span className="flex items-center gap-1.5">
                              <Icon name="clock" size={12} />
                              {cls.time}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleFindRoom(cls.room)
                              }}
                              className="flex items-center gap-1.5 hover:text-[var(--color-gold)] transition-colors"
                              title="Find this room on map"
                            >
                              <Icon name="mapPin" size={12} />
                              {cls.room}
                            </button>
                            <span className="flex items-center gap-1.5">
                              <Icon name="calendar" size={12} />
                              Meets {cls.pattern}
                              {!cls.isManual ? ` · ${cls.count} time${cls.count === 1 ? '' : 's'} this term` : ''}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              openEdit(cls)
                              setSelectedClass(cls)
                            }}
                            className={`p-2 rounded-lg ${config.bg} hover:ring-2 hover:ring-[var(--color-gold)] transition-all`}
                            title="Edit class"
                            aria-label={`Edit ${cls.code}`}
                          >
                            <Icon name="edit" size={16} className={config.text} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleHide(cls)
                            }}
                            className="p-2 rounded-lg hover:bg-red-500/10 hover:ring-2 hover:ring-red-500/40 transition-all"
                            title="Delete from schedule"
                            aria-label={`Delete ${cls.code} from schedule`}
                          >
                            <Icon name="trash" size={16} className="text-red-600 dark:text-red-400" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="hidden lg:block">
          <div className="card p-5 sticky top-24">
            {selectedClass ? (
              <div className="animate-fade-in">
                <div className={`text-[11px] font-semibold ${colorConfig[selectedClass.color].text} tracking-wide`}>
                  {selectedClass.code}
                </div>
                <h2 className="text-[17px] font-semibold text-[var(--color-txt-0)] mt-1">
                  {selectedClass.name}
                </h2>

                <div className="grid grid-cols-2 gap-3 mt-5">
                  <div className="bg-[var(--color-stat)] rounded-xl p-3">
                    <div className="text-[10px] text-[var(--color-txt-3)] uppercase tracking-wider mb-1">Day</div>
                    <div className="text-[13px] font-medium text-[var(--color-txt-0)]">{selectedClass.day}</div>
                  </div>
                  <div className="bg-[var(--color-stat)] rounded-xl p-3">
                    <div className="text-[10px] text-[var(--color-txt-3)] uppercase tracking-wider mb-1">Pattern</div>
                    <div className="text-[13px] font-medium text-[var(--color-txt-0)]">{selectedClass.pattern}</div>
                  </div>
                  <div className="bg-[var(--color-stat)] rounded-xl p-3">
                    <div className="text-[10px] text-[var(--color-txt-3)] uppercase tracking-wider mb-1">Time</div>
                    <div className="text-[13px] font-medium text-[var(--color-txt-0)]">{selectedClass.time}</div>
                  </div>
                  <div className="bg-[var(--color-stat)] rounded-xl p-3">
                    <div className="text-[10px] text-[var(--color-txt-3)] uppercase tracking-wider mb-1">Room</div>
                    <div className="text-[13px] font-medium text-[var(--color-txt-0)]">{selectedClass.room}</div>
                  </div>
                  <div className="bg-[var(--color-stat)] rounded-xl p-3 col-span-2">
                    <div className="text-[10px] text-[var(--color-txt-3)] uppercase tracking-wider mb-1">Source</div>
                    <div className="text-[13px] font-medium text-[var(--color-txt-0)]">
                      {selectedClass.isManual
                        ? 'Added manually'
                        : selectedClass.hasOverride
                          ? 'Imported · edited on this device'
                          : 'Imported from Purdue feed'}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2 mt-5">
                  <button
                    type="button"
                    onClick={() => openEdit(selectedClass)}
                    className="btn btn-primary text-[12px] px-4 py-2.5 w-full"
                  >
                    <Icon name="edit" size={14} />
                    Edit details
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFindRoom(selectedClass.room)}
                    className="btn btn-secondary text-[12px] px-4 py-2.5 w-full"
                  >
                    <Icon name="mapPin" size={14} />
                    Find Room
                  </button>
                  <button
                    type="button"
                    onClick={() => handleHide(selectedClass)}
                    className="text-[12px] px-4 py-2.5 rounded-xl border border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 inline-flex items-center justify-center gap-2"
                  >
                    <Icon name="trash" size={14} />
                    Delete from schedule
                  </button>
                  {selectedClass.hasOverride && !selectedClass.isManual ? (
                    <button
                      type="button"
                      onClick={() => handleReset(selectedClass)}
                      className="text-[12px] px-4 py-2.5 rounded-xl border border-[var(--color-border)] text-[var(--color-txt-2)] hover:bg-[var(--color-bg-2)]"
                    >
                      Reset to imported
                    </button>
                  ) : null}
                  <Link to="/setup" className="btn btn-secondary text-[12px] px-4 py-2.5 w-full">
                    <Icon name="calendar" size={14} />
                    Resync Feed
                  </Link>
                </div>
              </div>
            ) : (
              <div className="text-center py-12">
                <div className="w-14 h-14 rounded-2xl bg-[var(--color-stat)] flex items-center justify-center mx-auto mb-4">
                  <Icon name="calendar" size={24} className="text-[var(--color-txt-3)]" />
                </div>
                <p className="text-[14px] font-medium text-[var(--color-txt-1)]">No class selected</p>
                <p className="text-[12px] text-[var(--color-txt-3)] mt-1">
                  Choose a day with meetings, or add a class the feed missed
                </p>
                <button type="button" onClick={openAdd} className="btn btn-secondary text-[12px] px-4 py-2.5 mt-4">
                  Add class
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
