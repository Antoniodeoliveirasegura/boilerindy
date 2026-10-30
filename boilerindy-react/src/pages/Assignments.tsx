import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useQueryClient } from '@tanstack/react-query'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'
import { linkifyText, stripHtml } from '../lib/linkifyText'
import AiMarkdown from '../components/AiMarkdown'
import Icon from '../components/Icons'
import SourceErrorNotice from '../components/SourceErrorNotice'
import TaskCompleteReward from '../components/TaskCompleteReward'
import { rewardOriginFromEvent, type RewardOrigin } from '../lib/rewardOrigin'
import { loadLocalTasks, saveLocalTasks, taskMetaFromLocalStore } from '../lib/taskLocalStore'
import { isServerRefusal, writeFailureMessage } from '../lib/writeFailure'
import { loadPriorities, savePriority, PRIORITY_LEVELS } from '../lib/taskPriorityStore'
import { localIsoDate, startOfWeek } from '../lib/localDate'
import { splitCourseCode } from '../lib/courseCode'
import { dueSoonLabel } from '../lib/urgency'
import { aiCacheKey, describeAge, readAiCache, writeAiCache } from '../lib/aiInsightCache'
import {
  startOfLocalDayIso,
  useMyCalendar,
  useMyCalendarCategories,
  useTaskMeta,
  useToggleTaskCompletion,
  userKeys,
  type TaskMeta,
} from '../lib/queries/userData'
import { useEntrance } from '../hooks/useEntrance'
import PageTitle from '../components/PageTitle'

type Category = { id: string; label?: string; count?: number }
type CalItem = {
  id: string
  category?: string
  startTime?: string | null
  allDay?: boolean
  title?: string
  description?: string
  location?: string
  [key: string]: unknown
}
type MergedItem = {
  id: string
  category?: string
  startTime?: string | null
  allDay?: boolean
  title?: string
  description?: string
  location?: string
  completed: boolean
  isManual: boolean
  priority: string | null
  [key: string]: unknown
}

// Shown when the assistant fails without saying why (no response, or a body
// with no message). The chat panel says the same.
const ASSISTANT_UNREACHABLE = "Couldn't reach the assistant right now. Try again in a moment."

type AssistantAnswer = { reply: string } | { error: string }

// The insight from an /api/assistant response, or the message to show
// instead. Generate used to read only `reply`, so the hourly limit's 429 and
// the 502 when Groq fails put the button back with nothing said. A 200 marked
// busy or offline carries a status line, not an insight, so it is shown as
// the message and never cached as the week's ranking.
async function readAssistantAnswer(res: Response): Promise<AssistantAnswer> {
  const data = (await res.json().catch(() => null)) as { reply?: unknown; source?: unknown; error?: unknown } | null
  const reply = typeof data?.reply === 'string' ? data.reply : ''
  if (res.ok && reply && data?.source !== 'busy' && data?.source !== 'offline') return { reply }
  // The limiter sends `error` as a string; the app's error handler sends { message }.
  const error = data?.error as string | { message?: unknown } | null | undefined
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
  return { error: message || reply || ASSISTANT_UNREACHABLE }
}

// Shown under a write that got no answer, or a 5xx. Nothing was saved, so the
// page keeps the typed title or the old tick for another try.
const NOT_SAVED_ADD = 'Could not reach the server, so the task was not added. Please try again.'
const NOT_SAVED_TOGGLE = 'Could not reach the server, so the task was not updated. Please try again.'
const NOT_SAVED_DELETE = 'Could not reach the server, so the task was not deleted. Please try again.'

// Priority is a label plus a flag colour; the badge itself stays neutral. Only
// high is coloured: --color-warning is the signal amber in dark, and amber is
// kept for now, the primary action and urgency.
const priorityConfig: Record<string, { label: string; flag: string }> = {
  high: { label: 'High', flag: 'text-[var(--color-error)]' },
  medium: { label: 'Medium', flag: 'text-[var(--color-txt-2)]' },
  low: { label: 'Low', flag: 'text-[var(--color-txt-3)]' },
}

const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 }

const categoryConfig: Record<string, { label: string; icon: string }> = {
  exam: { label: 'Exams', icon: 'alert' },
  assignment: { label: 'Assignments', icon: 'edit' },
  lab: { label: 'Labs', icon: 'beaker' },
  project: { label: 'Projects', icon: 'folder' },
  quiz: { label: 'Quizzes', icon: 'document' },
  campus_event: { label: 'Campus Events', icon: 'calendar' },
  resource: { label: 'Resources', icon: 'document' },
  deadline: { label: 'Deadlines', icon: 'clock' },
  event: { label: 'Other', icon: 'calendar' },
  manual_task: { label: 'My tasks', icon: 'check' },
}

// Titles often lead with the course code ("CS 25100 Project 2"); the code goes
// on a plate above the rest of the title. The rule (a Purdue code, split only
// on whitespace) lives in lib/courseCode and is shared with Home and Schedule.
// A title that is only a code stays whole here, so the row keeps a title.
function titleParts(text: string): { code: string; rest: string } {
  const split = splitCourseCode(text)
  return split?.rest ? split : { code: '', rest: text.trim() }
}

// The departures date block: short weekday over the day of the month.
function whenParts(dateString: string | null | undefined) {
  if (!dateString) return null
  const date = new Date(dateString)
  return { day: date.toLocaleDateString(undefined, { weekday: 'short' }), date: date.getDate() }
}

// A to-do with no deadline (the mobile app makes these, and PATCH can clear
// one) is grouped and shown as "No due date" rather than under a blank
// heading with a bare "Due in".
function formatDate(dateString: string | null | undefined) {
  if (!dateString) return 'No due date'
  const date = new Date(dateString)
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const isToday = date.toDateString() === now.toDateString()
  const isTomorrow = date.toDateString() === tomorrow.toDateString()

  if (isToday) return 'Today'
  if (isTomorrow) return 'Tomorrow'

  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(dateString: string | null | undefined) {
  if (!dateString) return ''
  return new Date(dateString).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// Due-time label. D2L stamps deadlines at 23:59 local, which reads better as an
// end-of-day deadline than as a literal "11:59 PM". All-day items carry no
// clock time at all; callers skip the label for those (issue #121).
function formatDueTime(dateString: string | null | undefined) {
  if (!dateString) return ''
  const date = new Date(dateString)
  if (date.getHours() === 23 && date.getMinutes() === 59) return 'Due by end of day'
  return formatTime(dateString)
}

function getRelativeTime(dateString: string | null | undefined) {
  if (!dateString) return ''
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 0) return 'Past'
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays <= 7) return `${diffDays} days`
  if (diffDays <= 14) return '1-2 weeks'
  return `${Math.ceil(diffDays / 7)} weeks`
}

function isPastDue(dateString: string | null | undefined) {
  if (!dateString) return false
  return new Date(dateString) < new Date()
}

// Categories that belong on the Events page, not Tasks
const eventCategories = ['campus_event', 'event', 'deadline']

// One cache entry per user per local week, keyed by that week's Monday. The
// user id keeps the next account on a shared computer from reading these
// first-person rankings (issue #219); null (no user yet) skips the cache. The
// date has to come from local date parts: toISOString() gives the UTC date,
// which lags a day behind between local midnight and 09:00 on KST (and runs a
// day ahead in the Indianapolis evening), so the same week would flip between
// two keys.
function getInsightsCacheKey(userId: string | undefined, mode: string) {
  return userId ? aiCacheKey('assignments', userId, `${mode}-${localIsoDate(startOfWeek())}`) : null
}

export default function Assignments() {
  const { user, onboarding } = useAuth()
  const userId = user?.id as string | undefined
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [showPast, setShowPast] = useState(false)
  const [selectedItem, setSelectedItem] = useState<MergedItem | null>(null)

  const [insightsMode, setInsightsMode] = useState('priority')
  const [insightsText, setInsightsText] = useState<string | null>(
    () => readAiCache(getInsightsCacheKey(userId, 'priority'))?.text ?? null,
  )
  const [studyPlan, setStudyPlan] = useState<string | null>(
    () => readAiCache(getInsightsCacheKey(userId, 'study'))?.text ?? null,
  )
  const [insightsAt, setInsightsAt] = useState<Record<string, number | null>>(() => ({
    priority: readAiCache(getInsightsCacheKey(userId, 'priority'))?.at ?? null,
    study: readAiCache(getInsightsCacheKey(userId, 'study'))?.at ?? null,
  }))
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState('')
  const [insightsOpen, setInsightsOpen] = useState(true)

  // The calendar window, the categories and the task metadata through the
  // per-user query cache (issue #327): keyed by the user, never written to
  // storage. The window's lower bound is rounded to local midnight so the key
  // is stable within a day.
  const queryClient = useQueryClient()
  const calendarQuery = useMyCalendar<CalItem>({ limit: 500, from: startOfLocalDayIso(14) })
  const categoriesQuery = useMyCalendarCategories<Category>()
  const metaQuery = useTaskMeta()
  const toggleCompletion = useToggleTaskCompletion(userId ?? null)
  const items = useMemo<CalItem[]>(() => calendarQuery.data?.items ?? [], [calendarQuery.data])
  const categories = useMemo<Category[]>(() => categoriesQuery.data?.categories ?? [], [categoriesQuery.data])
  const loading = calendarQuery.isPending || categoriesQuery.isPending || metaQuery.isPending
  // Only the server's own "no task tables yet" answer (unavailable) puts this
  // page on the device store: every write goes there, and localMeta is the
  // snapshot it shows, re-read after every device-store write. A failed read
  // or write is not that answer. Both used to land here, so one blip hid every
  // task and tick on the account, showed the database setup notice to the
  // student, and sent every later add and tick to this browser alone; now the
  // page says what failed and offers to try again.
  const [localMeta, setLocalMeta] = useState<TaskMeta | null>(null)
  const tablesMissing = metaQuery.data?.unavailable === true
  const taskMeta = useMemo<TaskMeta>(() => {
    if (tablesMissing) {
      if (localMeta) return localMeta
      return userId
        ? (taskMetaFromLocalStore(userId) as TaskMeta)
        : { completions: [], manualTasks: [], unavailable: true, local: false }
    }
    return metaQuery.data ?? { completions: [], manualTasks: [] }
  }, [userId, localMeta, metaQuery.data, tablesMissing])
  const useLocalOnly = tablesMissing
  function rereadDeviceStore() {
    if (userId) setLocalMeta(taskMetaFromLocalStore(userId) as TaskMeta)
  }
  // A read that failed with nothing cached says so, with a way to try again,
  // instead of reading as an empty list ("No items found") or as tasks that
  // were never ticked. A failed background refetch keeps the last answer.
  const calendarFailed = calendarQuery.isError && !calendarQuery.data
  const metaFailed = metaQuery.isError && !metaQuery.data
  const loadFailure =
    calendarFailed && metaFailed
      ? 'Could not load your assignments or your tasks.'
      : calendarFailed
        ? 'Could not load your calendar, so imported assignments are missing.'
        : metaFailed
          ? 'Could not load your tasks, so your own tasks and check marks are missing.'
          : ''
  const retrying = calendarQuery.isFetching || metaQuery.isFetching
  function reloadAssignments() {
    void calendarQuery.refetch()
    void categoriesQuery.refetch()
    void metaQuery.refetch()
  }
  const [hideCompleted, setHideCompleted] = useState(false)
  const [priorities, setPriorities] = useState<Record<string, string>>(() => (userId ? loadPriorities(userId) : {}))
  const [priorityFilter, setPriorityFilter] = useState<string | null>(null)
  const [sortByPriority, setSortByPriority] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  // Local calendar day, not the UTC one: east of UTC the ISO date is still
  // yesterday until mid-morning, which made a fresh task past due on arrival.
  const [newDueDate, setNewDueDate] = useState(() => localIsoDate())
  const [addSubmitting, setAddSubmitting] = useState(false)
  const [taskError, setTaskError] = useState('')
  const [rewardOrigin, setRewardOrigin] = useState<RewardOrigin | null>(null)
  const [poppingId, setPoppingId] = useState<string | null>(null)
  const popClearRef = useRef<number | null>(null)
  // Insights that land after sign-out unmounted the page must not write the
  // cache back once sign-out has cleared it (issue #219).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const generateInsights = async (mode: string) => {
    setInsightsLoading(true)
    setInsightsError('')
    const prompt = mode === 'study'
      ? 'Look at my free time between classes this week, my upcoming assignments and my own task list. Build a short study plan: which item to work on, when (day and time), and for how long. Max 5 "-" bullets, each starting with the day and time in bold. Skip anything already marked DONE. No intro line, no closing line.'
      : 'Rank what I still have to do by urgency, most urgent first, pulling from both my synced assignments and my own task list. Max 6 "-" bullets. Bold the due date on each line and say in a few words why it ranks there. Skip anything already marked DONE and call out anything OVERDUE first. No intro line, no closing line.'
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
      })
      const answer = await readAssistantAnswer(res)
      if (!mountedRef.current) return
      if ('error' in answer) {
        setInsightsError(answer.error)
        return
      }
      const { at } = writeAiCache(getInsightsCacheKey(userId, mode), answer.reply)
      if (mode === 'study') setStudyPlan(answer.reply)
      else setInsightsText(answer.reply)
      setInsightsAt((prev) => ({ ...prev, [mode]: at }))
    } catch {
      if (mountedRef.current) setInsightsError(ASSISTANT_UNREACHABLE)
    } finally {
      setInsightsLoading(false)
    }
  }

  const activeInsight = insightsMode === 'study' ? studyPlan : insightsText

  // Below lg the details card stacks under the whole list, a screen or more
  // below the row, so a tap on a phone seemed to do nothing. Bring the card
  // into view there and move focus to its title, so a screen reader says what
  // opened; from lg it sits beside the list and is already in view. No
  // `behavior`: the page's CSS scroll-behavior is smooth, and auto when the
  // student asks for reduced motion.
  const detailRef = useRef<HTMLDivElement>(null)
  const detailTitleRef = useRef<HTMLHeadingElement>(null)
  const selectItem = (item: MergedItem) => {
    setSelectedItem(item)
    const wide = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches
    if (wide) return
    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ block: 'start' })
      detailTitleRef.current?.focus({ preventScroll: true })
    })
  }

  // Reload stored priorities when the signed-in user changes. Adjusting during
  // render (guarded by a user-id check) avoids the setState-in-effect warning;
  // the initial value is seeded in the useState initializer above.
  const [prevPriorityUid, setPrevPriorityUid] = useState<string | undefined>(userId)
  if (userId !== prevPriorityUid) {
    setPrevPriorityUid(userId)
    setPriorities(userId ? loadPriorities(userId) : {})
    // A page already in device-only mode would otherwise keep showing the
    // previous account's device-store snapshot until its next local write;
    // the queries re-key on their own.
    setLocalMeta(null)
  }

  function setItemPriority(item: MergedItem, priority: string | null) {
    const uid = userId
    if (!uid) {
      setTaskError('Sign in to set priorities.')
      return
    }
    const next = savePriority(uid, item.id, priority as 'high' | 'medium' | 'low' | null)
    setPriorities(next)
    setSelectedItem((prev) => (prev && prev.id === item.id ? { ...prev, priority } : prev))
  }

  const mergedItems = useMemo<MergedItem[]>(() => {
    const completionById: Record<string, string | undefined> = {}
    for (const c of taskMeta?.completions || []) {
      if (c.calendar_item_id) completionById[c.calendar_item_id] = c.completed_at
    }
    const cal: MergedItem[] = (items || []).map((item) => ({
      ...item,
      completed: !!completionById[item.id],
      isManual: false,
      priority: priorities[item.id] || null,
    }))
    const manual: MergedItem[] = (taskMeta?.manualTasks || []).map((t) => ({
      ...t,
      completed: !!t.completedAt,
      isManual: true,
      priority: priorities[t.id] || null,
    }))
    return [...cal, ...manual]
  }, [items, taskMeta, priorities])

  const categoriesWithManual = useMemo<Category[]>(() => {
    const n = mergedItems.filter((i) => i.isManual).length
    const extra = n > 0 ? [{ id: 'manual_task', label: 'My tasks', count: n }] : []
    return [...(categories || []), ...extra]
  }, [categories, mergedItems])

  const filteredItems = useMemo(() => {
    let filtered = mergedItems.filter(
      (item) => item.category !== 'class' && !eventCategories.includes(item.category ?? ''),
    )

    if (selectedCategories.length > 0) {
      filtered = filtered.filter((item) => selectedCategories.includes(item.category ?? ''))
    }

    if (!showPast) {
      filtered = filtered.filter((item) => !isPastDue(item.startTime))
    }

    if (hideCompleted) {
      filtered = filtered.filter((item) => !item.completed)
    }

    if (priorityFilter) {
      filtered = filtered.filter((item) => item.priority === priorityFilter)
    }

    return filtered.sort((a, b) => {
      if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1
      if (sortByPriority) {
        const rankA = a.priority ? priorityRank[a.priority] : 3
        const rankB = b.priority ? priorityRank[b.priority] : 3
        if (rankA !== rankB) return rankA - rankB
      }
      // Undated to-dos go last, as the server orders them, not first as 1970.
      if (!a.startTime || !b.startTime) return a.startTime ? -1 : b.startTime ? 1 : 0
      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    })
  }, [mergedItems, selectedCategories, showPast, hideCompleted, priorityFilter, sortByPriority])

  const groupedItems = useMemo(() => {
    const groups: Record<string, MergedItem[]> = {}
    for (const item of filteredItems) {
      const dateKey = formatDate(item.startTime)
      if (!groups[dateKey]) groups[dateKey] = []
      groups[dateKey].push(item)
    }
    return groups
  }, [filteredItems])

  // The day groups rise in when the tasks land and when a filter or the sort
  // the student picked swaps them (hooks/useEntrance).
  const daysRef = useEntrance(
    !loading && !loadFailure,
    [selectedCategories.join(','), showPast, hideCompleted, priorityFilter ?? '', sortByPriority].join('|'),
  )

  const toggleCategory = (catId: string) => {
    setSelectedCategories(prev => 
      prev.includes(catId) 
        ? prev.filter(c => c !== catId)
        : [...prev, catId]
    )
  }

  function applyLocalToggle(uid: string, item: MergedItem, nextDone: boolean) {
    mirrorToggleToLocalStore(uid, item, nextDone)
    rereadDeviceStore()
  }

  /** Persist completion to localStorage without flipping UI into local-only mode. */
  function mirrorToggleToLocalStore(uid: string, item: MergedItem, nextDone: boolean) {
    const raw = loadLocalTasks(uid)
    if (item.isManual) {
      const exists = raw.manualTasks.some((t) => t.id === item.id)
      if (exists) {
        raw.manualTasks = raw.manualTasks.map((t) =>
          t.id === item.id ? { ...t, completedAt: nextDone ? new Date().toISOString() : null } : t,
        )
      } else {
        raw.manualTasks = [
          ...raw.manualTasks,
          {
            id: item.id,
            title: item.title || 'Task',
            startTime: item.startTime ?? null,
            completedAt: nextDone ? new Date().toISOString() : null,
          },
        ]
      }
    } else if (nextDone) {
      raw.completions[item.id] = new Date().toISOString()
    } else {
      delete raw.completions[item.id]
    }
    saveLocalTasks(uid, raw)
  }

  // The metadata itself is patched by the mutation (useToggleTaskCompletion);
  // the open detail panel keeps its own copy of the item.
  function reflectToggleInSelection(item: MergedItem, nextDone: boolean) {
    setSelectedItem((prev) => (prev && prev.id === item.id ? { ...prev, completed: nextDone } : prev))
  }

  function playCompleteReward(itemId: string, e?: React.MouseEvent) {
    setRewardOrigin(rewardOriginFromEvent(e))
    setPoppingId(itemId)
    if (popClearRef.current) window.clearTimeout(popClearRef.current)
    popClearRef.current = window.setTimeout(() => setPoppingId(null), 420)
  }

  async function toggleItemComplete(item: MergedItem, nextDone: boolean, e?: React.MouseEvent) {
    e?.preventDefault()
    e?.stopPropagation()
    setTaskError('')
    const uid = userId
    if (!uid) {
      setTaskError('Sign in to save tasks.')
      return
    }

    reflectToggleInSelection(item, nextDone)
    if (nextDone) playCompleteReward(item.id, e)

    if (useLocalOnly) {
      applyLocalToggle(uid, item, nextDone)
      if (nextDone) track('task_completed')
      return
    }

    try {
      // The tick lands in the cached metadata before the request goes out
      // (issue #327); the checkbox never waits on the network.
      await toggleCompletion.mutateAsync({ id: item.id, isManual: item.isManual, completed: nextDone })
      if (nextDone) track('task_completed')
      // Keep the device copy aligned so a later fallback cannot snap the checkbox back.
      mirrorToggleToLocalStore(uid, item, nextDone)
    } catch (err) {
      console.error(err)
      // Not saved, whether the server refused (the user-write limiter's 429, a
      // 404 for an item a sync removed; issue #202) or never answered (offline,
      // a 5xx): the mutation has already put the metadata back; undo the
      // panel's copy and say why. A tick kept on this device after no answer
      // used to switch the whole page to the device store.
      reflectToggleInSelection(item, item.completed)
      setTaskError(
        writeFailureMessage(err, isServerRefusal(err) ? 'Could not update this task. Please try again.' : NOT_SAVED_TOGGLE),
      )
    }
  }

  async function deleteManualTask(id: string) {
    const uid = userId
    if (!uid) return
    setTaskError('')
    if (useLocalOnly) {
      const raw = loadLocalTasks(uid)
      raw.manualTasks = raw.manualTasks.filter((t) => t.id !== id)
      saveLocalTasks(uid, raw)
      rereadDeviceStore()
      setSelectedItem(null)
      return
    }
    try {
      await authRequest(`/api/me/tasks/manual/${id}`, { method: 'DELETE' })
      setSelectedItem(null)
      await queryClient.invalidateQueries({ queryKey: userKeys.taskMeta(uid) })
    } catch (e) {
      console.error(e)
      // Refused (issue #202) or never answered: either way the task is still
      // on the server, so keep it listed and keep calling the server. Removing
      // it on this device alone used to switch the page to the device store.
      setTaskError(
        writeFailureMessage(e, isServerRefusal(e) ? 'Could not delete this task. Please try again.' : NOT_SAVED_DELETE),
      )
    }
  }

  async function handleAddManualTask(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const t = newTitle.trim()
    if (!t || addSubmitting) return
    // A cleared date field used to make Add task do nothing at all.
    if (!newDueDate) {
      setTaskError('Pick a due date for this task.')
      return
    }
    const due = new Date(`${newDueDate}T12:00:00`)
    due.setHours(23, 59, 59, 999)
    const uid = userId
    if (!uid) {
      setTaskError('Sign in to add tasks.')
      return
    }
    setAddSubmitting(true)
    setTaskError('')

    if (useLocalOnly) {
      const raw = loadLocalTasks(uid)
      raw.manualTasks.push({
        id: crypto.randomUUID(),
        title: t,
        startTime: due.toISOString(),
        completedAt: null,
      })
      saveLocalTasks(uid, raw)
      rereadDeviceStore()
      setNewTitle('')
      setAddSubmitting(false)
      return
    }

    try {
      await authRequest('/api/me/tasks/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t, dueAt: due.toISOString() }),
      })
      setNewTitle('')
      await queryClient.invalidateQueries({ queryKey: userKeys.taskMeta(uid) })
    } catch (err) {
      console.error(err)
      // Refused (the 500-task cap's 409, the limiter's 429; issue #202) or
      // never answered (offline, a 5xx): nothing was saved, so keep the typed
      // title for another try and stay online. A task saved on this device
      // instead was gone after a reload (nothing ever sent it to the account)
      // and switched the page to the device store for every later add.
      setTaskError(
        writeFailureMessage(err, isServerRefusal(err) ? 'Could not add this task. Please try again.' : NOT_SAVED_ADD),
      )
    } finally {
      setAddSubmitting(false)
    }
  }

  const hasNoSources = onboarding?.linkedSourceCount === 0

  useEffect(() => {
    return () => {
      if (popClearRef.current) window.clearTimeout(popClearRef.current)
    }
  }, [])

  const fieldLabel = 'mb-1.5 block text-[13px] font-semibold text-[var(--color-txt-1)]'
  // Same height as the Refresh btn-sm beside them: 44px on phones, 34px up.
  const toggleLabel = 'pill cursor-pointer gap-2 select-none md:min-h-[34px]'
  const toggleBox = 'h-4 w-4 shrink-0 accent-[var(--color-txt-0)]'

  return (
    <div className="page">
      <PageTitle>Tasks</PageTitle>
      <TaskCompleteReward
        origin={rewardOrigin}
        onDone={() => setRewardOrigin(null)}
      />
      {/* A feed that stopped syncing shows here, not only on the Connect page (issue #12). */}
      <SourceErrorNotice className="mb-6" />
      <header className="page-head">
        <div>
          <h1 className="page-title">Tasks</h1>
          <p className="page-sub">
            {filteredItems.length} item{filteredItems.length === 1 ? '' : 's'} · Brightspace imports and tasks you add
          </p>
          {taskError ? (
            <p className="mt-2 text-[13.5px] font-medium text-[var(--color-error)]">{taskError}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className={toggleLabel}>
            <input
              type="checkbox"
              checked={sortByPriority}
              onChange={(e) => setSortByPriority(e.target.checked)}
              className={toggleBox}
            />
            Sort by priority
          </label>
          <label className={toggleLabel}>
            <input
              type="checkbox"
              checked={hideCompleted}
              onChange={(e) => setHideCompleted(e.target.checked)}
              className={toggleBox}
            />
            Hide done
          </label>
          <label className={toggleLabel}>
            <input
              type="checkbox"
              checked={showPast}
              onChange={(e) => setShowPast(e.target.checked)}
              className={toggleBox}
            />
            Show past items
          </label>
          <button onClick={reloadAssignments} className="btn btn-ghost btn-sm max-md:px-0">
            <Icon name="refresh" size={14} />
            <span className="max-md:sr-only">Refresh</span>
          </button>
        </div>
      </header>

      {loadFailure && (
        <div
          role="alert"
          className="card mb-5 flex flex-wrap items-center gap-x-2.5 gap-y-2 px-4 py-3 text-[13px] leading-relaxed text-[var(--color-txt-1)]"
        >
          <Icon name="alert" size={16} className="shrink-0 text-[var(--color-error)]" />
          <span className="min-w-0 flex-1">{loadFailure}</span>
          <button type="button" onClick={reloadAssignments} disabled={retrying} className="btn btn-ghost btn-sm disabled:opacity-40">
            {retrying ? 'Trying…' : 'Try again'}
          </button>
        </div>
      )}

      {tablesMissing && (
        <div className="card mb-5 flex items-start gap-2.5 px-4 py-3 text-[13px] leading-relaxed text-[var(--color-txt-2)]">
          <Icon name="info" size={16} className="mt-0.5 shrink-0 text-[var(--color-txt-2)]" />
          <div className="min-w-0">
            <span className="font-semibold text-[var(--color-txt-1)]">Tasks work in this browser: </span>
            checkboxes and &ldquo;My tasks&rdquo; are saved locally until the database is set up. Run{' '}
            <code className="rounded-[var(--radius-xs)] bg-[var(--color-stat)] px-1 text-[12px]">supabase-user-tasks.sql</code>{' '}
            in the Supabase SQL Editor so completions sync to your account across devices.
          </div>
        </div>
      )}

      <section className="card card-pad r-tsk mb-5">
        <div className="eyebrow mb-4">
          Add a task
        </div>
        <form onSubmit={handleAddManualTask} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor="new-task-title" className={fieldLabel}>
              Title
            </label>
            <input
              id="new-task-title"
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Finish lab write-up"
              className="input"
            />
          </div>
          <div className="w-full shrink-0 sm:w-48">
            <label htmlFor="new-task-due" className={fieldLabel}>
              Due date
            </label>
            <input
              id="new-task-due"
              type="date"
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
              className="input tnum"
            />
          </div>
          <button
            type="submit"
            disabled={addSubmitting || !newTitle.trim()}
            className="btn btn-primary min-h-[44px] w-full shrink-0 sm:w-auto"
          >
            {addSubmitting ? 'Adding…' : 'Add task'}
          </button>
        </form>
      </section>

      {hasNoSources && (
        <section className="card card-pad r-tsk mb-5 flex flex-col gap-4 sm:flex-row sm:items-center">
          <span className="route-badge">
            <Icon name="calendar" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="card-title">
              Connect your Brightspace calendar
            </div>
            <p className="mt-1 max-w-[640px] text-[13.5px] leading-snug text-[var(--color-txt-2)]">
              Import your assignments, exams, and due dates from Brightspace to see them here.
            </p>
          </div>
          <Link to="/setup" className="btn btn-ink w-fit shrink-0">
            <Icon name="calendar" size={16} />
            Connect Brightspace
          </Link>
        </section>
      )}

      {categoriesWithManual.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedCategories([])}
            className={`pill whitespace-nowrap ${selectedCategories.length === 0 ? 'pill-active' : ''}`}
          >
            All ({mergedItems.filter((i) => i.category !== 'class' && !eventCategories.includes(i.category ?? '')).length})
          </button>
          {categoriesWithManual.filter((c) => c.id !== 'class' && !eventCategories.includes(c.id)).map((cat) => {
            const isActive = selectedCategories.includes(cat.id)
            return (
              <button
                key={cat.id}
                onClick={() => toggleCategory(cat.id)}
                className={`pill whitespace-nowrap ${isActive ? 'pill-active' : ''}`}
              >
                {cat.label} ({cat.count})
              </button>
            )
          })}
          <span className="mx-1 w-px self-stretch bg-[var(--color-border-2)]" aria-hidden="true" />
          {PRIORITY_LEVELS.map((level) => {
            const isActive = priorityFilter === level
            return (
              <button
                key={level}
                onClick={() => setPriorityFilter(isActive ? null : level)}
                className={`pill whitespace-nowrap ${isActive ? 'pill-active' : ''}`}
                title={`Show only ${priorityConfig[level].label.toLowerCase()} priority tasks`}
              >
                <Icon name="flag" size={12} className={isActive ? '' : priorityConfig[level].flag} />
                {priorityConfig[level].label}
              </button>
            )
          })}
        </div>
      )}

      {/* AI Insights Panel, only with AI suggestions on in Settings */}
      {user?.aiOptIn === true && !hasNoSources && !loading && filteredItems.length > 0 && (
        <section className="card card-pad r-ai mb-5">
          {/* card-head as on Events' Recommended card. The title row is the
              collapse toggle (a real button, so it works from the keyboard);
              the Generate action sits at the right while the card is open. */}
          <header className={`card-head ${insightsOpen ? '' : 'mb-0'}`}>
            <button
              type="button"
              onClick={() => setInsightsOpen((v) => !v)}
              aria-expanded={insightsOpen}
              className="-my-1.5 flex min-h-[44px] min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[var(--radius-md)] text-left"
            >
              <span className="route-badge">
                <Icon name="sparkles" size={18} />
              </span>
              <span className="card-title">AI Insights</span>
              <Icon name={insightsOpen ? 'chevronUp' : 'chevronDown'} size={18} className="text-[var(--color-txt-2)]" />
            </button>
            {insightsOpen && (
              <button
                onClick={() => void generateInsights(insightsMode)}
                disabled={insightsLoading}
                className="head-link disabled:opacity-40"
              >
                {insightsLoading ? 'Generating…' : activeInsight ? 'Refresh' : 'Generate'}
              </button>
            )}
          </header>
          {insightsOpen && (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {/* Ink-only active state: the sparkles badge is this card's one amber. */}
                {['priority', 'study'].map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setInsightsMode(m)
                      setInsightsError('')
                    }}
                    className={`pill ${insightsMode === m ? 'pill-active shadow-none' : ''}`}
                  >
                    {m === 'priority' ? 'Priority Ranking' : 'Study Plan'}
                  </button>
                ))}
              </div>
              {insightsError && (
                <p role="alert" className="mb-2 text-[13px] text-[var(--color-error)]">
                  {insightsError}
                </p>
              )}
              {insightsLoading && !activeInsight ? (
                <div className="flex items-center gap-2 py-2 text-[13.5px] text-[var(--color-txt-2)]">
                  <Icon name="refresh" size={14} className="animate-spin" />
                  Analyzing your tasks…
                </div>
              ) : activeInsight ? (
                <>
                  <AiMarkdown className="text-[14px] text-[var(--color-txt-1)]">{activeInsight}</AiMarkdown>
                  {insightsAt[insightsMode] && (
                    <p className="mt-2 text-[12px] text-[var(--color-txt-3)]">
                      Generated {describeAge(insightsAt[insightsMode])} - refresh after you check things off.
                    </p>
                  )}
                </>
              ) : (
                <p className="py-1 text-[13.5px] text-[var(--color-txt-2)]">
                  Click &ldquo;Generate&rdquo; to get AI-powered {insightsMode === 'priority' ? 'priority ranking' : 'study plan'} based on your schedule and deadlines.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {loading ? (
        <div className="card card-pad text-center text-[14px] text-[var(--color-txt-2)]">
          Loading tasks...
        </div>
      ) : filteredItems.length === 0 && loadFailure ? (
        // The failed read is said above; "No items found" would claim the
        // calendar is empty when it never loaded.
        null
      ) : filteredItems.length === 0 ? (
        <div className="card card-pad">
          <div className="empty">
            <span className="ico">
              <Icon name="calendar" size={18} />
            </span>
            <div>
              <div className="font-display text-[15px] font-bold text-[var(--color-txt-0)]">No items found</div>
              <p className="mt-1">
                {hasNoSources
                  ? 'Connect your Brightspace calendar to see tasks and events.'
                  : selectedCategories.length > 0
                    ? 'Try selecting different categories or showing past items.'
                    : 'No upcoming tasks or events.'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
          <section ref={daysRef} className="card card-pad r-tsk min-w-0">
            {Object.entries(groupedItems).map(([date, dateItems], groupIndex) => (
              <div key={date} className={groupIndex > 0 ? 'mt-2' : ''}>
                <div className="eyebrow bare">
                  {date}
                </div>
                <ol className="dep">
                  {dateItems.map(item => {
                    const config = categoryConfig[item.category ?? ''] || categoryConfig.event
                    const isSelected = selectedItem?.id === item.id
                    const past = isPastDue(item.startTime)
                    const { code, rest } = titleParts(item.title ?? '')
                    const when = whenParts(item.startTime)
                    // Urgent: open and due within the next 24 hours (lib/urgency,
                    // shared with Home). Past-due rows fade instead.
                    const dueSoon = dueSoonLabel(item.startTime, { completed: item.completed })

                    return (
                      <li key={item.id} className={dueSoon ? 'urgent' : undefined}>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => selectItem(item)}
                          onKeyDown={(e) => {
                            // Keys pressed on the nested Mark as done button bubble
                            // here too; preventDefault cancelled the button's own
                            // Enter and Space, so the keyboard opened the details
                            // instead of ticking the task.
                            if (e.target !== e.currentTarget) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              selectItem(item)
                            }
                          }}
                          className={`dep-row group -mx-2 w-[calc(100%+16px)] cursor-pointer grid-cols-[36px_48px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] px-2 transition-colors sm:-mx-3 sm:w-[calc(100%+24px)] sm:grid-cols-[36px_48px_minmax(0,1fr)_auto] sm:gap-x-3.5 sm:px-3 ${
                            isSelected
                              ? 'bg-[var(--color-surface-hover)] shadow-[inset_3px_0_0_var(--color-txt-0)]'
                              : 'hover:bg-[var(--color-surface-hover)]'
                          } ${past && !item.completed ? 'opacity-60' : ''}`}
                        >
                          <button
                            type="button"
                            onClick={(e) => toggleItemComplete(item, !item.completed, e)}
                            className={`-ml-2 grid h-11 w-11 place-items-center rounded-[var(--radius-md)] ${poppingId === item.id ? 'task-check-pop' : ''}`}
                            aria-label={item.completed ? 'Mark as not done' : 'Mark as done'}
                          >
                            <span
                              className={`grid h-[22px] w-[22px] place-items-center rounded-[var(--radius-sm)] border-2 transition-colors ${
                                item.completed
                                  ? 'border-[var(--route)] bg-[var(--route)] text-[var(--route-on)]'
                                  : 'border-[var(--color-border-3)] bg-[var(--color-surface)] group-hover:border-[var(--color-txt-2)]'
                              }`}
                            >
                              {item.completed ? <Icon name="check" size={14} strokeWidth={3} /> : null}
                            </span>
                          </button>
                          <span className="when" aria-hidden="true">
                            {when ? (
                              <>
                                <span>{when.day}</span>
                                <b>{when.date}</b>
                              </>
                            ) : null}
                          </span>
                          <div className="body">
                            {code ? <span className="code">{code}</span> : null}
                            <div
                              className={`ttl line-clamp-2 ${
                                item.completed ? 'text-[var(--color-txt-3)] line-through' : ''
                              }`}
                            >
                              {rest}
                            </div>
                            <div className="meta flex flex-wrap items-center gap-x-3 gap-y-1.5">
                              {!item.allDay && item.startTime && (
                                <span className="inline-flex items-center gap-1">
                                  <Icon name="clock" size={12} />
                                  {formatDueTime(item.startTime)}
                                </span>
                              )}
                              {item.location && (
                                <span className="inline-flex min-w-0 items-center gap-1 truncate">
                                  <Icon name="mapPin" size={12} />
                                  {item.location.split(' (')[0]}
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1">
                                <Icon name="tag" size={12} />
                                {config.label}
                              </span>
                              {item.priority && (
                                <span className="badge">
                                  <Icon name="flag" size={10} className={priorityConfig[item.priority].flag} />
                                  {priorityConfig[item.priority].label}
                                </span>
                              )}
                            </div>
                          </div>
                          {dueSoon ? (
                            <span
                              aria-hidden="true"
                              className="badge badge-signal col-start-3 justify-self-start sm:col-start-4 sm:row-start-1 sm:justify-self-end"
                            >
                              {dueSoon}
                            </span>
                          ) : (
                            <span className="end hidden sm:flex" aria-hidden="true">
                              <Icon name="chevronRight" size={18} />
                            </span>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ))}
          </section>

          {/* On phones this column stacks under the whole list, so the empty
              placeholder only shows from lg; a selected item still shows. The
              placeholder skips the entry fade: an element that toggles display
              at a breakpoint replays it and can be caught at opacity 0. */}
          <div
            ref={detailRef}
            className={`h-fit min-w-0 scroll-mt-24 lg:sticky lg:top-24 ${
              selectedItem ? 'animate-fade-in-up' : 'hidden lg:block'
            }`}
          >
            {selectedItem ? (
              <div className="card card-pad r-tsk min-w-0 overflow-hidden">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <span className="badge badge-route">
                    {(categoryConfig[selectedItem.category ?? ''] || categoryConfig.event).label}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedItem(null)}
                    className="icon-btn -mr-2 -mt-2"
                    aria-label="Close details"
                  >
                    <Icon name="close" size={18} />
                  </button>
                </div>

                <h3
                  ref={detailTitleRef}
                  tabIndex={-1}
                  className={`mb-4 text-[19px] leading-snug focus:outline-none ${
                    selectedItem.completed ? 'text-[var(--color-txt-3)] line-through' : 'text-[var(--color-txt-0)]'
                  }`}
                >
                  {selectedItem.title}
                </h3>

                <div className="mb-5">
                  <div className="eyebrow bare mb-2">
                    Priority
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {PRIORITY_LEVELS.map((level) => {
                      const isActive = selectedItem.priority === level
                      return (
                        <button
                          key={level}
                          type="button"
                          onClick={() => setItemPriority(selectedItem, isActive ? null : level)}
                          aria-pressed={isActive}
                          className={`pill ${isActive ? 'pill-active' : ''}`}
                        >
                          <Icon name="flag" size={12} className={isActive ? '' : priorityConfig[level].flag} />
                          {priorityConfig[level].label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="mb-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={(e) => toggleItemComplete(selectedItem, !selectedItem.completed, e)}
                    className="btn btn-secondary btn-sm"
                  >
                    {selectedItem.completed ? 'Mark not done' : 'Mark done'}
                  </button>
                  {selectedItem.isManual && (
                    <button
                      type="button"
                      onClick={() => deleteManualTask(selectedItem.id)}
                      className="btn btn-ghost btn-sm text-[var(--color-error)] hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)]"
                    >
                      Delete task
                    </button>
                  )}
                </div>

                <div className="mb-1 border-t border-[var(--color-border)]">
                  <div className="flex items-center gap-3 border-b border-[var(--color-border)] py-3 text-[14px]">
                    <Icon name="calendar" size={16} className="shrink-0 text-[var(--color-txt-3)]" />
                    <div className="tnum">
                      <div className="font-display font-bold text-[var(--color-txt-0)]">{formatDate(selectedItem.startTime)}</div>
                      {!selectedItem.allDay && selectedItem.startTime && (
                        <div className="text-[12.5px] text-[var(--color-txt-2)]">{formatDueTime(selectedItem.startTime)}</div>
                      )}
                    </div>
                  </div>

                  {selectedItem.location && (
                    <div className="flex min-w-0 items-start gap-3 border-b border-[var(--color-border)] py-3 text-[14px]">
                      <Icon name="mapPin" size={16} className="mt-0.5 shrink-0 text-[var(--color-txt-3)]" />
                      <div className="min-w-0 break-words text-[var(--color-txt-1)] [overflow-wrap:anywhere]">
                        {/^https?:\/\//i.test(selectedItem.location.trim()) ? (
                          <a
                            href={selectedItem.location.trim()}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all text-[var(--color-accent)] hover:underline"
                          >
                            {selectedItem.location.trim().length > 72
                              ? `${selectedItem.location.trim().slice(0, 72)}…`
                              : selectedItem.location.trim()}
                          </a>
                        ) : (
                          selectedItem.location
                        )}
                      </div>
                    </div>
                  )}

                  {/* No deadline, no countdown: the date row already says "No due date". */}
                  {selectedItem.startTime && (
                    <div className="flex items-center gap-3 border-b border-[var(--color-border)] py-3 text-[14px]">
                      <Icon name="clock" size={16} className="shrink-0 text-[var(--color-txt-3)]" />
                      <div>
                        <div className={`font-display font-bold ${isPastDue(selectedItem.startTime) ? 'text-[var(--color-error)]' : 'text-[var(--color-txt-0)]'}`}>
                          {isPastDue(selectedItem.startTime) ? 'Past due' : `Due in ${getRelativeTime(selectedItem.startTime)}`}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {selectedItem.description && (
                  <div className="min-w-0 pt-4">
                    <div className="eyebrow bare mb-2">
                      Description
                    </div>
                    <div className="min-w-0 max-w-full break-words text-[13.5px] leading-relaxed text-[var(--color-txt-1)] [overflow-wrap:anywhere]">
                      {(() => {
                        const full = stripHtml(selectedItem.description)
                        const truncated = full.length > 800
                        const chunk = truncated ? full.slice(0, 800) : full
                        return (
                          <>
                            {linkifyText(chunk, { maxDisplayLength: 96 })}
                            {truncated ? '…' : ''}
                          </>
                        )
                      })()}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="card card-pad">
                <div className="empty">
                  <span className="ico">
                    <Icon name="document" size={18} />
                  </span>
                  <p>Select an item to view details</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
