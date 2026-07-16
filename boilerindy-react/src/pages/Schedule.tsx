import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { extractBuildingCode } from '../lib/buildingCode'
import Icon from '../components/Icons'
import { filterClassItemsForSchedulePage } from '../lib/scheduleFilters'

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
  return new Date(dateValue).toLocaleDateString(undefined, { weekday: 'long' })
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

function getWeeklyPattern(items: ClassItem[]): Record<string, ClassEntry[]> {
  const seen = new Map<string, ClassEntry>()
  const seriesDays = new Map<string, Set<string>>()

  for (const item of items) {
    if (!item.startTime) continue
    const day = getDayName(item.startTime)
    if (!DAYS.includes(day)) continue

    const start = new Date(item.startTime)
    const end = item.endTime ? new Date(item.endTime) : null
    const key = [
      day,
      item.title,
      item.description || '',
      item.location || '',
      start.getHours(),
      start.getMinutes(),
      end?.getHours() || '',
      end?.getMinutes() || '',
    ].join('|')
    const seriesKey = [
      item.title,
      item.description || '',
      item.location || '',
    ].join('|')

    const existingDays = seriesDays.get(seriesKey) || new Set()
    existingDays.add(day)
    seriesDays.set(seriesKey, existingDays)

    if (!seen.has(key)) {
      seen.set(key, {
        id: key,
        seriesKey,
        day,
        code: item.title || '',
        name: item.description || 'Class meeting',
        time: getTimeRange(item.startTime, item.endTime),
        room: item.location || 'Location unavailable',
        startTime: item.startTime,
        endTime: item.endTime,
        color: colorOrder[seen.size % colorOrder.length],
        count: 1,
      })
    } else {
      seen.get(key)!.count += 1
    }
  }

  const grouped: Record<string, ClassEntry[]> = Object.fromEntries(
    DAYS.map((day) => [day, [] as ClassEntry[]]),
  )
  for (const item of seen.values()) {
    grouped[item.day].push({
      ...item,
      pattern: getPatternLabel([...(seriesDays.get(item.seriesKey) || [item.day])]),
    })
  }

  for (const day of DAYS) {
    grouped[day].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  }

  return grouped
}

export default function Schedule() {
  const { onboarding } = useAuth()
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

  const handleFindRoom = (room: string) => {
    const buildingCode = extractBuildingCode(room)
    if (buildingCode) {
      navigate(`/map?building=${buildingCode}&room=${encodeURIComponent(room)}`)
    } else {
      navigate(`/map?room=${encodeURIComponent(room)}`)
    }
  }

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
  const schedule = useMemo(() => getWeeklyPattern(scheduleClassItems), [scheduleClassItems])
  const classes = useMemo(() => schedule[selectedDay] || [], [schedule, selectedDay])

  // Keep the selected class valid as the day/class list changes. Adjusting during
  // render (guarded by a class-list identity check) avoids the setState-in-effect
  // cascading-render warning. `classes` is derived from `selectedDay`, so its
  // identity already changes when the day changes.
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
        <div className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl px-4 py-2.5 shadow-sm">
          <Icon name="calendar" size={14} className="text-[var(--color-txt-3)]" />
          Weekly view from your Purdue timetable feed
        </div>
      </div>

      {banner && (
        <div className="card p-4 mb-6 text-[13px] text-[var(--color-error)]">
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

      <div className="card p-1.5 mb-6 animate-fade-in-up stagger-1">
        <div className="flex gap-1 overflow-x-auto">
          {DAYS.map((day) => {
            const isSelected = selectedDay === day
            const hasClasses = (schedule[day] || []).length > 0
            return (
              <button
                key={day}
                onClick={() => setSelectedDay(day)}
                className={`flex-1 min-w-[88px] text-[13px] py-2.5 rounded-xl transition-all duration-300 relative
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
                {needsSetup ? 'Finish setup to populate this schedule.' : 'No recurring class meetings were found for this day.'}
              </p>
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
                              onClick={(e) => { e.stopPropagation(); handleFindRoom(cls.room); }}
                              className="flex items-center gap-1.5 hover:text-[var(--color-gold)] transition-colors"
                              title="Find this room on map"
                            >
                              <Icon name="mapPin" size={12} />
                              {cls.room}
                            </button>
                            <span className="flex items-center gap-1.5">
                              <Icon name="calendar" size={12} />
                              Meets {cls.pattern} · {cls.count} time{cls.count === 1 ? '' : 's'} this term
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleFindRoom(cls.room); }}
                          className={`shrink-0 p-2 rounded-lg ${config.bg} hover:ring-2 hover:ring-[var(--color-gold)] transition-all`}
                          title="Find room on map"
                        >
                          <Icon name="mapPin" size={16} className={config.text} />
                        </button>
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
                  <div className="bg-[var(--color-stat)] rounded-xl p-3">
                    <div className="text-[10px] text-[var(--color-txt-3)] uppercase tracking-wider mb-1">Meetings</div>
                    <div className="text-[13px] font-medium text-[var(--color-txt-0)]">{selectedClass.count} in this term</div>
                  </div>
                </div>

                <div className="flex gap-2 mt-5">
                  <button
                    onClick={() => handleFindRoom(selectedClass.room)}
                    className="btn btn-primary text-[12px] px-4 py-2.5 flex-1"
                  >
                    <Icon name="mapPin" size={14} />
                    Find Room
                  </button>
                  <Link to="/setup" className="btn btn-secondary text-[12px] px-4 py-2.5 flex-1">
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
                <p className="text-[12px] text-[var(--color-txt-3)] mt-1">Choose a day with imported meetings to view details</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
