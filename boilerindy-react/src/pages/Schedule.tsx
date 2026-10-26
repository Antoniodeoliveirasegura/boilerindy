import { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { mapHrefForRoom } from '../lib/buildingCode'
import { splitCourseCode } from '../lib/courseCode'
import { errorMessage } from '../lib/queries/publicData'
import { useMyClasses } from '../lib/queries/userData'
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
  SCHEDULE_OVERRIDES_EVENT,
  updateManualClass,
  type ScheduleOverrideState,
  type ScheduleSeriesOverride,
} from '../lib/scheduleOverrideStore'
import PageTitle from '../components/PageTitle'

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

// Course titles from the feed often lead with the course code ("CS 25100
// Data Structures"); the code goes on a plate and the rest stays as text. The
// rule (a Purdue code, split only on whitespace) lives in lib/courseCode and is
// shared with Home and Assignments. A title that is only a code shows just the
// plate here.
function CourseCode({ text, className = '' }: { text: string; className?: string }) {
  const { code, rest } = splitCourseCode(text) ?? { code: '', rest: text.trim() }
  return (
    <>
      {code ? <span className="code solid">{code}</span> : null}
      {rest ? <span className={className}>{rest}</span> : null}
    </>
  )
}

// The time gutter: "9:30" over "AM", from the meeting's local start time.
function gutterTime(iso: string): { hm: string; half: string } {
  const date = new Date(iso)
  const hours = date.getHours()
  const hm = `${((hours + 11) % 12) + 1}:${String(date.getMinutes()).padStart(2, '0')}`
  return { hm, half: hours < 12 ? 'AM' : 'PM' }
}

function minutesOfDay(iso: string): number {
  const date = new Date(iso)
  return date.getHours() * 60 + date.getMinutes()
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

// The weekdays the feed has a meeting on, per series, before any day override.
// An override's days can only hide those meetings, never add one.
function feedDaysBySeries(items: ClassItem[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const item of items) {
    if (!item.startTime) continue
    const seriesKey = makeSeriesKey(item)
    const days = out.get(seriesKey) || new Set<string>()
    days.add(getDayName(item.startTime))
    out.set(seriesKey, days)
  }
  return out
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
  const [banner, setBanner] = useState('')
  // The chronological class list through the per-user query cache (#327);
  // Home reads the display-mode entry of the same route.
  const classesQuery = useMyClasses<ClassItem>({ limit: 500, mode: 'chronological' })
  const loading = classesQuery.isPending
  const classItems = useMemo<ClassItem[]>(() => classesQuery.data?.items ?? [], [classesQuery.data])
  const classesMeta = useMemo<{ totalInTerm?: number }>(() => classesQuery.data?.meta ?? { totalInTerm: 0 }, [classesQuery.data])
  const termLabel = classesQuery.data?.meta?.selectedTermLabel || ''
  const loadBanner = classesQuery.isError ? errorMessage(classesQuery.error, 'Could not load your class schedule.') : ''
  const [overrides, setOverrides] = useState<ScheduleOverrideState>(() => loadScheduleOverrides(userId))
  const [editing, setEditing] = useState(false)
  // The class the editor was opened for. Save, Reset to imported and the
  // feed-day check act on it, not on selectedClass: a tap on another row or a
  // day-tab switch changes the selection while the editor stays open, and the
  // editor's buttons then saved or reset that other class (R25).
  const [editTarget, setEditTarget] = useState<ClassEntry | null>(null)
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
  // The times the editor opened with, so saveEdit can tell a time the student
  // changed from one it only showed.
  const openedTimesRef = useRef<{ startHm: string; endHm: string } | null>(null)

  // Home's Get Directions builds the same link (lib/buildingCode.ts).
  const handleFindRoom = (room: string) => {
    navigate(mapHrefForRoom(room))
  }

  // Re-read on user change and whenever the server pull (or another tab) lands,
  // so edits made elsewhere show up without a reload.
  useEffect(() => {
    const refresh = () => setOverrides(loadScheduleOverrides(userId))
    refresh()
    window.addEventListener(SCHEDULE_OVERRIDES_EVENT, refresh)
    return () => window.removeEventListener(SCHEDULE_OVERRIDES_EVENT, refresh)
  }, [userId])

  const scheduleClassItems = useMemo(
    () => filterClassItemsForSchedulePage(classItems),
    [classItems],
  )
  const placeholderHiddenCount = classItems.length - scheduleClassItems.length
  const schedule = useMemo(
    () => getWeeklyPattern(scheduleClassItems, overrides),
    [scheduleClassItems, overrides],
  )
  const feedDays = useMemo(() => feedDaysBySeries(scheduleClassItems), [scheduleClassItems])
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
      // Take the fresh entry for the same meeting: the old object kept the
      // details from before an edit, so the panel hid Reset to imported until
      // the student picked the class again (R25).
      setSelectedClass((current) =>
        (current && classes.find((item) => item.id === current.id)) || classes[0],
      )
    }
  }

  const needsSetup = onboarding?.needsPurdueConnection || onboarding?.needsScheduleSource

  // The wall clock for the "now" rule on today's column, refreshed each minute.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const todayName = getDayName(now)
  // Where the now rule sits in today's list: before the first meeting that has
  // not started yet (after the last one once the day is done).
  const nowIndex = useMemo(() => {
    if (selectedDay !== todayName || !classes.length) return -1
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    const next = classes.findIndex((cls) => minutesOfDay(cls.startTime) > nowMinutes)
    return next === -1 ? classes.length : next
  }, [classes, now, selectedDay, todayName])

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
    setEditTarget(cls)
    setFormError('')
    const startHm = isoToHm(cls.startTime)
    const endHm = isoToHm(cls.endTime || cls.startTime)
    openedTimesRef.current = { startHm, endHm }
    setForm({
      code: cls.code,
      name: cls.name,
      room: cls.room === 'Location unavailable' ? '' : cls.room,
      startHm,
      endHm,
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
    if (!uid || !editTarget) return
    const invalid = validateForm()
    if (invalid) {
      setFormError(invalid)
      return
    }

    if (editTarget.isManual && editTarget.manualId) {
      setOverrides(
        updateManualClass(uid, editTarget.manualId, {
          code: form.code,
          name: form.name,
          room: form.room,
          startHm: form.startHm,
          endHm: form.endHm,
          days: form.days,
        }),
      )
    } else {
      // The editor shows the clicked meeting's times, but the override applies
      // to every meeting in the series. Writing them on every save moved a
      // class that meets at other times on other days to this day's time,
      // even when only the room changed (R24). So the times go in only when
      // the student changed one; otherwise any earlier time edit carries over.
      const previous = overrides.series[editTarget.seriesKey]
      const opened = openedTimesRef.current
      const timesChanged = !opened || form.startHm !== opened.startHm || form.endHm !== opened.endHm
      const patch: ScheduleSeriesOverride = {
        code: form.code.trim(),
        name: form.name.trim() || 'Class meeting',
        room: form.room.trim(),
        startHm: timesChanged ? form.startHm : previous?.startHm,
        endHm: timesChanged ? form.endHm : previous?.endHm,
        days: form.days,
      }
      setOverrides(saveSeriesOverride(uid, editTarget.seriesKey, patch))
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
  const importedDays = editing && editTarget && !editTarget.isManual ? feedDays.get(editTarget.seriesKey) : null
  const fieldLabel = 'block text-[13px] font-semibold text-[var(--color-txt-1)]'
  const closeEditor = () => {
    setEditing(false)
    setAdding(false)
    setFormError('')
  }

  return (
    <div className="page">
      <PageTitle>Class Schedule</PageTitle>
      <header className="page-head">
        <div>
          <h1 className="page-title">Class Schedule</h1>
          <p className="page-sub">
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
            <button type="button" onClick={restoreHidden} className="btn btn-secondary">
              Restore {hiddenCount} deleted
            </button>
          ) : null}
          <button type="button" onClick={openAdd} className="btn btn-primary">
            <Icon name="plus" size={16} />
            Add class
          </button>
        </div>
      </header>

      {(banner || loadBanner) && (
        <div className="card mb-5 flex items-start gap-2.5 px-4 py-3 text-[13.5px] text-[var(--color-txt-1)]">
          <Icon name="info" size={16} className="mt-0.5 text-[var(--color-txt-2)]" />
          <span className="min-w-0">{banner || loadBanner}</span>
        </div>
      )}

      {needsSetup && (
        <section className="card card-pad r-cls mb-5 flex flex-col gap-4 sm:flex-row sm:items-center">
          <span className="route-badge">
            <Icon name={onboarding?.needsPurdueConnection ? 'graduation' : 'calendar'} size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="card-title">
              {onboarding?.needsPurdueConnection ? 'Link Purdue to import your schedule' : 'Connect your Purdue timetable feed'}
            </div>
            {/* needsPurdueConnection is also false when linking is off
                (PURDUE_AUTH_MODE=off), so only hasPurdueLinked may claim a
                link (issue #372). */}
            <p className="mt-1 max-w-[640px] text-[13.5px] leading-snug text-[var(--color-txt-2)]">
              {onboarding?.needsPurdueConnection
                ? 'Your BoilerIndy account is ready. Link Purdue first, then attach your timetable iCal export.'
                : onboarding?.hasPurdueLinked
                  ? 'Your Purdue account is linked. Finish setup to sync your recurring class meetings into this page.'
                  : 'Connect your timetable feed to sync your recurring class meetings into this page.'}
            </p>
          </div>
          <Link to="/setup" className="btn btn-ink w-fit shrink-0">
            <Icon name={onboarding?.needsPurdueConnection ? 'graduation' : 'calendar'} size={16} />
            Open setup
          </Link>
        </section>
      )}

      {editorOpen ? (
        <section className="card card-pad mb-5">
          <header className="card-head items-start">
            <div>
              <h2 className="card-title">{adding ? 'Add a class' : 'Edit class'}</h2>
              <p className="card-sub">
                Fixes stay on this device and keep working after you re-sync the Purdue feed.
              </p>
            </div>
            <button
              type="button"
              onClick={closeEditor}
              className="icon-btn -mr-2 -mt-2 ml-auto shrink-0"
              aria-label="Close editor"
            >
              <Icon name="close" size={18} />
            </button>
          </header>

          <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <label className={fieldLabel}>
              Course code
              <input
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                className="input mt-1.5 font-normal"
                placeholder="CS 18000"
              />
            </label>
            <label className={fieldLabel}>
              Name / section
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="input mt-1.5 font-normal"
                placeholder="Problem Solving And Object-Oriented Programming"
              />
            </label>
            <label className={fieldLabel}>
              Room / location
              <input
                value={form.room}
                onChange={(e) => setForm((f) => ({ ...f, room: e.target.value }))}
                className="input mt-1.5 font-normal"
                placeholder="LWSN B155"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className={fieldLabel}>
                Starts
                <input
                  type="time"
                  value={form.startHm}
                  onChange={(e) => setForm((f) => ({ ...f, startHm: e.target.value }))}
                  className="input tnum mt-1.5 font-normal"
                />
              </label>
              <label className={fieldLabel}>
                Ends
                <input
                  type="time"
                  value={form.endHm}
                  onChange={(e) => setForm((f) => ({ ...f, endHm: e.target.value }))}
                  className="input tnum mt-1.5 font-normal"
                />
              </label>
            </div>
          </div>

          <div className="mt-4">
            <div className={`${fieldLabel} mb-2`}>Meets on</div>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((day) => {
                const active = form.days.includes(day)
                // An imported class can only drop days the feed has. Turning on
                // another day saved and said "Schedule updated" but showed
                // nothing on that day (R47).
                const notInFeed = Boolean(importedDays && !importedDays.has(day) && !active)
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(day)}
                    disabled={notInFeed}
                    className={`pill min-w-[56px] justify-center disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'pill-active' : ''}`}
                  >
                    {day.slice(0, 3)}
                  </button>
                )
              })}
            </div>
            {!adding && !editTarget?.isManual ? (
              <p className="mt-2 text-[12px] text-[var(--color-txt-3)]">
                Uncheck a day to hide that meeting if the feed put it on the wrong weekday. To add a meeting on another day, use Add class.
              </p>
            ) : null}
          </div>

          {formError ? (
            <p className="mt-3 text-[13px] font-medium text-[var(--color-error)]">{formError}</p>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={adding ? saveAdd : saveEdit} className="btn btn-ink">
              {adding ? 'Add to schedule' : 'Save changes'}
            </button>
            <button type="button" onClick={closeEditor} className="btn btn-secondary">
              Cancel
            </button>
            {/* Below lg the detail panel, which holds the other Reset to
                imported, is hidden, so phones and tablets had no way back to
                the feed's values (R25). */}
            {!adding && editTarget?.hasOverride && !editTarget.isManual ? (
              <button type="button" onClick={() => handleReset(editTarget)} className="btn btn-ghost lg:hidden">
                Reset to imported
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
        <section className="card r-cls min-w-0">
          {/* Weekday strip. On phones the five short names share the card's
              width: at 88px each, Thu and Fri sat past the edge of a 390px
              screen behind a sideways scroll. A day keeps at least 48px, so
              only a screen narrower than about 300px still scrolls, inside
              the card and never the page (issue #162). From sm the full
              names keep 88px. Each day carries a 4px top rule: amber for
              today, ink for the selected day, and one small square per
              meeting. */}
          <div className="flex gap-1 overflow-x-auto rounded-t-[var(--radius-xl)] border-b border-[var(--color-border)] p-1.5">
            {DAYS.map((day) => {
              const isSelected = selectedDay === day
              const isToday = todayName === day
              const meetings = (schedule[day] || []).length
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => setSelectedDay(day)}
                  aria-pressed={isSelected}
                  aria-current={isToday ? 'date' : undefined}
                  className={`flex min-w-[48px] flex-1 shrink-0 flex-col items-start gap-1.5 whitespace-nowrap border-t-4 px-2 pb-2 pt-2 text-left font-display text-[14px] transition-colors sm:min-w-[88px] sm:px-3
                    ${isToday ? 'border-[var(--color-gold)]' : isSelected ? 'border-[var(--color-txt-0)]' : 'border-[var(--color-bg-3)]'}
                    ${isSelected
                      ? 'bg-[var(--color-stat)] font-extrabold text-[var(--color-txt-0)]'
                      : 'font-bold text-[var(--color-txt-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-txt-0)]'
                    }`}
                >
                  <span className="hidden sm:inline">{day}</span>
                  <span className="sm:hidden">{day.slice(0, 3)}</span>
                  <span aria-hidden="true" className="flex h-[6px] gap-[3px]">
                    {Array.from({ length: Math.min(meetings, 5) }, (_, i) => (
                      <span key={i} className="h-[6px] w-[6px] rounded-[1px] bg-[var(--route)]" />
                    ))}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="p-3 sm:p-4 md:p-5">
            {loading ? (
              <p className="py-6 text-center text-[15px] font-medium text-[var(--color-txt-1)]">Loading imported classes…</p>
            ) : classes.length === 0 ? (
              <div className="empty">
                <span className="ico">
                  <Icon name="calendar" size={18} />
                </span>
                <div>
                  <p className="font-display text-[15px] font-bold text-[var(--color-txt-0)]">No weekly classes scheduled</p>
                  <p className="mt-1">
                    {needsSetup
                      ? 'Finish setup to populate this schedule, or add a class manually.'
                      : 'No recurring class meetings were found for this day. Add one if the feed missed it.'}
                  </p>
                </div>
                <button type="button" onClick={openAdd} className="btn btn-secondary btn-sm">
                  Add class
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {classes.map((cls, idx) => {
                  const isSelected = selectedClass?.id === cls.id
                  const gutter = gutterTime(cls.startTime)

                  return (
                    <div key={cls.id} className="space-y-3">
                      {idx === nowIndex ? <NowRule /> : null}
                      <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-2.5 sm:grid-cols-[52px_minmax(0,1fr)] sm:gap-4">
                        <div aria-hidden="true" className="pt-3 text-right font-display font-extrabold leading-none">
                          <span className="tnum block text-[15px] text-[var(--color-txt-1)] sm:text-[16px]">{gutter.hm}</span>
                          <span className="mt-1 block text-[10.5px] tracking-[0.12em] text-[var(--color-txt-3)]">{gutter.half}</span>
                        </div>
                        <div
                          onClick={() => setSelectedClass(cls)}
                          className={`min-w-0 cursor-pointer rounded-[var(--radius-md)] bg-[var(--color-cls-bg)] py-3 pl-4 pr-1.5 transition-shadow sm:pl-5 sm:pr-2
                            ${isSelected
                              ? /* The selection only drives the lg detail panel, so the ring shows from lg. */
                                'shadow-[inset_4px_0_0_var(--color-cls-sub)] lg:shadow-[inset_4px_0_0_var(--color-cls-sub),0_0_0_2px_var(--color-txt-0)]'
                              : 'shadow-[inset_4px_0_0_var(--color-cls-sub)] hover:shadow-[inset_4px_0_0_var(--color-cls-sub),0_0_0_1px_var(--color-border-3)]'
                            }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                                <CourseCode
                                  text={cls.code}
                                  className="font-display text-[13.5px] font-bold text-[var(--color-txt-1)]"
                                />
                                <span className="badge bg-[var(--color-surface)]">{cls.pattern}</span>
                                {cls.isManual ? <span className="badge bg-[var(--color-surface)]">Added</span> : null}
                                {cls.hasOverride && !cls.isManual ? <span className="badge bg-[var(--color-surface)]">Edited</span> : null}
                              </div>
                              <div className="mt-1.5 font-display text-[16px] font-bold leading-snug text-[var(--color-txt-0)]">
                                {cls.name}
                              </div>
                              <div className="tnum mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-[var(--color-txt-2)]">
                                <span className="flex items-center gap-1.5">
                                  <Icon name="clock" size={13} />
                                  {cls.time}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleFindRoom(cls.room)
                                  }}
                                  className="flex items-center gap-1.5 rounded-[var(--radius-xs)] font-medium text-[var(--color-txt-1)] underline-offset-2 hover:text-[var(--color-accent)] hover:underline"
                                  title="Find this room on map"
                                >
                                  <Icon name="mapPin" size={13} />
                                  {cls.room}
                                </button>
                                <span className="flex items-center gap-1.5">
                                  <Icon name="calendar" size={13} />
                                  Meets {cls.pattern}
                                  {!cls.isManual ? ` · ${cls.count} time${cls.count === 1 ? '' : 's'} this term` : ''}
                                </span>
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-center sm:flex-row">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openEdit(cls)
                                  setSelectedClass(cls)
                                }}
                                className="icon-btn hover:bg-[var(--color-surface)] md:h-9 md:w-9"
                                title="Edit class"
                                aria-label={`Edit ${cls.code}`}
                              >
                                <Icon name="edit" size={16} />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleHide(cls)
                                }}
                                className="icon-btn hover:bg-[var(--color-surface)] hover:text-[var(--color-error)] md:h-9 md:w-9"
                                title="Delete from schedule"
                                aria-label={`Delete ${cls.code} from schedule`}
                              >
                                <Icon name="trash" size={16} />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {nowIndex === classes.length ? <NowRule /> : null}
              </div>
            )}
          </div>
        </section>

        <div className="hidden lg:block">
          <div className="card card-pad r-cls sticky top-24">
            {selectedClass ? (
              <div className="animate-fade-in">
                <div className="flex flex-wrap items-center gap-2">
                  <CourseCode
                    text={selectedClass.code}
                    className="font-display text-[13.5px] font-bold text-[var(--color-txt-1)]"
                  />
                </div>
                <h2 className="mt-2 text-[22px] leading-tight text-[var(--color-txt-0)]">
                  {selectedClass.name}
                </h2>

                <dl className="mt-4 grid grid-cols-2 gap-x-4 border-t border-[var(--color-border)]">
                  {[
                    ['Day', selectedClass.day],
                    ['Pattern', selectedClass.pattern],
                    ['Time', selectedClass.time],
                    ['Room', selectedClass.room],
                  ].map(([label, value]) => (
                    <div key={label} className="border-b border-[var(--color-border)] py-3">
                      <dt className="eyebrow bare">{label}</dt>
                      <dd className="tnum mt-1.5 font-display text-[14px] font-bold leading-snug text-[var(--color-txt-0)]">{value}</dd>
                    </div>
                  ))}
                  <div className="col-span-2 border-b border-[var(--color-border)] py-3">
                    <dt className="eyebrow bare">Source</dt>
                    <dd className="mt-1.5 font-display text-[14px] font-bold leading-snug text-[var(--color-txt-0)]">
                      {selectedClass.isManual
                        ? 'Added manually'
                        : selectedClass.hasOverride
                          ? 'Imported · edited on this device'
                          : 'Imported from Purdue feed'}
                    </dd>
                  </div>
                </dl>

                <div className="mt-5 flex flex-col gap-2">
                  <button type="button" onClick={() => openEdit(selectedClass)} className="btn btn-ink w-full">
                    <Icon name="edit" size={16} />
                    Edit details
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFindRoom(selectedClass.room)}
                    className="btn btn-secondary w-full"
                  >
                    <Icon name="mapPin" size={16} />
                    Find Room
                  </button>
                  <Link to="/setup" className="btn btn-secondary w-full">
                    <Icon name="calendar" size={16} />
                    Resync Feed
                  </Link>
                  {selectedClass.hasOverride && !selectedClass.isManual ? (
                    <button type="button" onClick={() => handleReset(selectedClass)} className="btn btn-ghost w-full">
                      Reset to imported
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleHide(selectedClass)}
                    className="btn btn-ghost w-full text-[var(--color-error)] hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)]"
                  >
                    <Icon name="trash" size={16} />
                    Delete from schedule
                  </button>
                </div>
              </div>
            ) : (
              <div className="empty">
                <span className="ico">
                  <Icon name="calendar" size={18} />
                </span>
                <div>
                  <p className="font-display text-[15px] font-bold text-[var(--color-txt-0)]">No class selected</p>
                  <p className="mt-1">Choose a day with meetings, or add a class the feed missed</p>
                </div>
                <button type="button" onClick={openAdd} className="btn btn-secondary btn-sm">
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

/** Today's "now" rule: a 2px amber line with an amber stop ringed in ink. */
function NowRule() {
  return (
    <div aria-hidden="true" className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-2.5 sm:grid-cols-[52px_minmax(0,1fr)] sm:gap-4">
      <span />
      <span className="relative block h-[2px] bg-[var(--color-gold)]">
        <span className="absolute -left-[6px] -top-[5px] h-3 w-3 rounded-full bg-[var(--color-gold)] shadow-[0_0_0_2px_var(--color-txt-0)]" />
      </span>
    </div>
  )
}
