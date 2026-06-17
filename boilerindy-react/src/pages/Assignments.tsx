import { useEffect, useState, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'
import { linkifyText, stripHtml, cleanAiText } from '../lib/linkifyText'
import Icon from '../components/Icons'
import { loadLocalTasks, saveLocalTasks, taskMetaFromLocalStore } from '../lib/taskLocalStore'
import { loadPriorities, savePriority, PRIORITY_LEVELS } from '../lib/taskPriorityStore'

type Category = { id: string; label?: string; count?: number }
type Completion = { calendar_item_id?: string; completed_at?: string }
type ManualTask = {
  id: string
  title?: string
  startTime?: string | null
  completedAt?: string | null
  [key: string]: unknown
}
type TaskMeta = {
  completions: Completion[]
  manualTasks: ManualTask[]
  unavailable?: boolean
  local?: boolean
}
type CalItem = {
  id: string
  category?: string
  startTime?: string | null
  title?: string
  description?: string
  location?: string
  [key: string]: unknown
}
type MergedItem = {
  id: string
  category?: string
  startTime?: string | null
  title?: string
  description?: string
  location?: string
  completed: boolean
  isManual: boolean
  priority: string | null
  [key: string]: unknown
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

const priorityConfig: Record<string, { label: string; bg: string; text: string; border: string }> = {
  high: {
    label: 'High',
    bg: 'bg-red-50 dark:bg-red-900/20',
    text: 'text-red-700 dark:text-red-400',
    border: 'border-red-200 dark:border-red-800',
  },
  medium: {
    label: 'Medium',
    bg: 'bg-amber-50 dark:bg-amber-900/20',
    text: 'text-amber-700 dark:text-amber-400',
    border: 'border-amber-200 dark:border-amber-800',
  },
  low: {
    label: 'Low',
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    text: 'text-emerald-700 dark:text-emerald-400',
    border: 'border-emerald-200 dark:border-emerald-800',
  },
}

const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 }

const categoryConfig: Record<string, { label: string; bg: string; text: string; border: string; icon: string }> = {
  exam: {
    label: 'Exams',
    bg: 'bg-red-50 dark:bg-red-900/20', 
    text: 'text-red-700 dark:text-red-400', 
    border: 'border-red-200 dark:border-red-800',
    icon: 'alert'
  },
  assignment: { 
    label: 'Assignments',
    bg: 'bg-blue-50 dark:bg-blue-900/20', 
    text: 'text-blue-700 dark:text-blue-400', 
    border: 'border-blue-200 dark:border-blue-800',
    icon: 'edit'
  },
  lab: { 
    label: 'Labs',
    bg: 'bg-green-50 dark:bg-green-900/20', 
    text: 'text-green-700 dark:text-green-400', 
    border: 'border-green-200 dark:border-green-800',
    icon: 'beaker'
  },
  project: { 
    label: 'Projects',
    bg: 'bg-purple-50 dark:bg-purple-900/20', 
    text: 'text-purple-700 dark:text-purple-400', 
    border: 'border-purple-200 dark:border-purple-800',
    icon: 'folder'
  },
  quiz: { 
    label: 'Quizzes',
    bg: 'bg-orange-50 dark:bg-orange-900/20', 
    text: 'text-orange-700 dark:text-orange-400', 
    border: 'border-orange-200 dark:border-orange-800',
    icon: 'document'
  },
  campus_event: { 
    label: 'Campus Events',
    bg: 'bg-pink-50 dark:bg-pink-900/20', 
    text: 'text-pink-700 dark:text-pink-400', 
    border: 'border-pink-200 dark:border-pink-800',
    icon: 'calendar'
  },
  resource: { 
    label: 'Resources',
    bg: 'bg-gray-50 dark:bg-gray-800/50', 
    text: 'text-gray-600 dark:text-gray-300', 
    border: 'border-gray-200 dark:border-gray-700',
    icon: 'document'
  },
  deadline: { 
    label: 'Deadlines',
    bg: 'bg-yellow-50 dark:bg-yellow-900/20', 
    text: 'text-yellow-700 dark:text-yellow-400', 
    border: 'border-yellow-200 dark:border-yellow-800',
    icon: 'clock'
  },
  event: { 
    label: 'Other',
    bg: 'bg-[var(--color-bg-2)]', 
    text: 'text-[var(--color-txt-1)]', 
    border: 'border-[var(--color-border)]',
    icon: 'calendar'
  },
  manual_task: {
    label: 'My tasks',
    bg: 'bg-teal-50 dark:bg-teal-900/20',
    text: 'text-teal-700 dark:text-teal-400',
    border: 'border-teal-200 dark:border-teal-800',
    icon: 'check',
  },
}

function formatDate(dateString: string | null | undefined) {
  if (!dateString) return ''
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

function getInsightsCacheKey(mode: string) {
  const d = new Date()
  const day = d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  return `ai-assignments-${mode}-${monday.toISOString().slice(0, 10)}`
}

export default function Assignments() {
  const { user, onboarding } = useAuth()
  const userId = user?.id as string | undefined
  const [items, setItems] = useState<CalItem[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [showPast, setShowPast] = useState(false)
  const [selectedItem, setSelectedItem] = useState<MergedItem | null>(null)

  const [insightsMode, setInsightsMode] = useState('priority')
  const [insightsText, setInsightsText] = useState<string | null>(() => {
    try { return JSON.parse(localStorage.getItem(getInsightsCacheKey('priority')) || 'null') ?? null } catch { return null }
  })
  const [studyPlan, setStudyPlan] = useState<string | null>(() => {
    try { return JSON.parse(localStorage.getItem(getInsightsCacheKey('study')) || 'null') ?? null } catch { return null }
  })
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsOpen, setInsightsOpen] = useState(true)

  const [taskMeta, setTaskMeta] = useState<TaskMeta>({ completions: [], manualTasks: [] })
  const [hideCompleted, setHideCompleted] = useState(false)
  const [priorities, setPriorities] = useState<Record<string, string>>(() => (userId ? loadPriorities(userId) : {}))
  const [priorityFilter, setPriorityFilter] = useState<string | null>(null)
  const [sortByPriority, setSortByPriority] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDueDate, setNewDueDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [addSubmitting, setAddSubmitting] = useState(false)
  const [taskError, setTaskError] = useState('')

  const generateInsights = (mode: string) => {
    setInsightsLoading(true)
    const prompt = mode === 'study'
      ? 'Look at my free time between classes this week and my upcoming assignments. Create a short study plan: which assignment to work on, when (day and time), and for how long. Max 5 items. Plain text only, no markdown, no asterisks, no bold, no headers. Complete every sentence.'
      : 'Rank my upcoming assignments by urgency. Most urgent first. One line per item with format: [!] or [~] or [ok] then the assignment name and when it is due. Plain text only, no markdown, no asterisks, no bold, no headers. Complete every line.'
    fetch('/api/assistant', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.reply) {
          const clean = cleanAiText(d.reply)
          if (mode === 'study') {
            setStudyPlan(clean)
            try { localStorage.setItem(getInsightsCacheKey('study'), JSON.stringify(clean)) } catch { /* quota */ }
          } else {
            setInsightsText(clean)
            try { localStorage.setItem(getInsightsCacheKey('priority'), JSON.stringify(clean)) } catch { /* quota */ }
          }
        }
      })
      .catch(() => {})
      .finally(() => setInsightsLoading(false))
  }

  const activeInsight = insightsMode === 'study' ? studyPlan : insightsText

  const loadTaskMeta = useCallback(async () => {
    const uid = userId
    setTaskError('')
    try {
      const meta = (await authRequest('/api/me/tasks/meta')) as TaskMeta & { unavailable?: boolean }
      if (meta.unavailable) {
        if (uid) {
          setTaskMeta(taskMetaFromLocalStore(uid) as TaskMeta)
        } else {
          setTaskMeta({ completions: [], manualTasks: [], unavailable: true, local: false })
        }
        return
      }
      setTaskMeta({ ...meta, unavailable: false, local: false })
    } catch {
      if (uid) {
        setTaskMeta(taskMetaFromLocalStore(uid) as TaskMeta)
      } else {
        setTaskMeta({ completions: [], manualTasks: [], unavailable: true, local: false })
      }
    }
  }, [userId])

  async function loadData() {
    setLoading(true)
    try {
      // Fetch from 14 days ago so the 500-item window covers upcoming items
      // rather than being swamped by historical data
      const from = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
      const [calRes, catRes] = await Promise.all([
        authRequest(`/api/me/calendar?limit=500&from=${encodeURIComponent(from)}`),
        authRequest('/api/me/calendar/categories'),
      ])
      setItems((calRes as { items?: CalItem[] }).items || [])
      setCategories((catRes as { categories?: Category[] }).categories || [])
      await loadTaskMeta()
    } catch (error) {
      console.error('Failed to load assignments:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // loadData performs its setState after an await; calling it inside an IIFE
    // keeps the effect body free of a synchronous setState call. loadData is a
    // freshly-created function each render, so it stays out of the dep array.
    void (async () => {
      await loadData()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!user?.id) return
    void (async () => {
      await loadTaskMeta()
    })()
  }, [user?.id, loadTaskMeta])

  // Reload stored priorities when the signed-in user changes. Adjusting during
  // render (guarded by a user-id check) avoids the setState-in-effect warning;
  // the initial value is seeded in the useState initializer above.
  const [prevPriorityUid, setPrevPriorityUid] = useState<string | undefined>(userId)
  if (userId !== prevPriorityUid) {
    setPrevPriorityUid(userId)
    setPriorities(userId ? loadPriorities(userId) : {})
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
      return new Date(a.startTime ?? 0).getTime() - new Date(b.startTime ?? 0).getTime()
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

  const toggleCategory = (catId: string) => {
    setSelectedCategories(prev => 
      prev.includes(catId) 
        ? prev.filter(c => c !== catId)
        : [...prev, catId]
    )
  }

  function applyLocalToggle(uid: string, item: MergedItem, nextDone: boolean) {
    const raw = loadLocalTasks(uid)
    if (item.isManual) {
      raw.manualTasks = raw.manualTasks.map((t) =>
        t.id === item.id ? { ...t, completedAt: nextDone ? new Date().toISOString() : null } : t,
      )
    } else if (nextDone) {
      raw.completions[item.id] = new Date().toISOString()
    } else {
      delete raw.completions[item.id]
    }
    saveLocalTasks(uid, raw)
    setTaskMeta(taskMetaFromLocalStore(uid))
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

    const useLocalOnly = taskMeta.local === true || taskMeta.unavailable === true
    if (useLocalOnly) {
      applyLocalToggle(uid, item, nextDone)
      return
    }

    try {
      if (item.isManual) {
        await authRequest(`/api/me/tasks/manual/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ completed: nextDone }),
        })
      } else {
        await authRequest('/api/me/tasks/calendar/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarItemId: item.id, completed: nextDone }),
        })
      }
      if (nextDone) track('task_completed')
      await loadTaskMeta()
    } catch (err) {
      console.error(err)
      setTaskError(errorText(err, 'Server sync failed — saved on this device.'))
      applyLocalToggle(uid, item, nextDone)
    }
  }

  async function deleteManualTask(id: string) {
    const uid = userId
    if (!uid) return
    setTaskError('')
    const useLocalOnly = taskMeta.local === true || taskMeta.unavailable === true
    if (useLocalOnly) {
      const raw = loadLocalTasks(uid)
      raw.manualTasks = raw.manualTasks.filter((t) => t.id !== id)
      saveLocalTasks(uid, raw)
      setTaskMeta(taskMetaFromLocalStore(uid))
      setSelectedItem(null)
      return
    }
    try {
      await authRequest(`/api/me/tasks/manual/${id}`, { method: 'DELETE' })
      setSelectedItem(null)
      await loadTaskMeta()
    } catch (e) {
      console.error(e)
      setTaskError(errorText(e, 'Could not delete on server — removed on this device only.'))
      const raw = loadLocalTasks(uid)
      raw.manualTasks = raw.manualTasks.filter((t) => t.id !== id)
      saveLocalTasks(uid, raw)
      setTaskMeta(taskMetaFromLocalStore(uid))
      setSelectedItem(null)
    }
  }

  async function handleAddManualTask(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const t = newTitle.trim()
    if (!t || !newDueDate || addSubmitting) return
    const due = new Date(`${newDueDate}T12:00:00`)
    due.setHours(23, 59, 59, 999)
    const uid = userId
    if (!uid) {
      setTaskError('Sign in to add tasks.')
      return
    }
    setAddSubmitting(true)
    setTaskError('')

    const useLocalOnly = taskMeta.local === true || taskMeta.unavailable === true
    if (useLocalOnly) {
      const raw = loadLocalTasks(uid)
      raw.manualTasks.push({
        id: crypto.randomUUID(),
        title: t,
        startTime: due.toISOString(),
        completedAt: null,
      })
      saveLocalTasks(uid, raw)
      setTaskMeta(taskMetaFromLocalStore(uid))
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
      await loadTaskMeta()
    } catch (err) {
      console.error(err)
      setTaskError(errorText(err, 'Could not save to server — saved on this device.'))
      const raw = loadLocalTasks(uid)
      raw.manualTasks.push({
        id: crypto.randomUUID(),
        title: t,
        startTime: due.toISOString(),
        completedAt: null,
      })
      saveLocalTasks(uid, raw)
      setTaskMeta(taskMetaFromLocalStore(uid))
      setNewTitle('')
    } finally {
      setAddSubmitting(false)
    }
  }

  const hasNoSources = onboarding?.linkedSourceCount === 0

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-8 pb-24 transition-opacity duration-500 opacity-100">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6 animate-fade-in-up">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Assignments</h1>
          <p className="text-[14px] text-[var(--color-txt-2)] mt-1">
            {filteredItems.length} item{filteredItems.length === 1 ? '' : 's'} · Brightspace imports and tasks you add
          </p>
          {taskError ? (
            <p className="text-[13px] text-red-600 dark:text-red-400 mt-2">{taskError}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)] cursor-pointer">
            <input
              type="checkbox"
              checked={sortByPriority}
              onChange={(e) => setSortByPriority(e.target.checked)}
              className="w-4 h-4 rounded border-[var(--color-border-2)]"
            />
            Sort by priority
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)] cursor-pointer">
            <input
              type="checkbox"
              checked={hideCompleted}
              onChange={(e) => setHideCompleted(e.target.checked)}
              className="w-4 h-4 rounded border-[var(--color-border-2)]"
            />
            Hide done
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)] cursor-pointer">
            <input 
              type="checkbox" 
              checked={showPast} 
              onChange={(e) => setShowPast(e.target.checked)}
              className="w-4 h-4 rounded border-[var(--color-border-2)]"
            />
            Show past items
          </label>
          <button onClick={loadData} className="btn btn-secondary text-[13px] px-4 py-2">
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        </div>
      </div>

      {taskMeta.unavailable && (
        <div className="card p-4 mb-4 border-amber-500/30 bg-amber-500/5 text-[13px] text-[var(--color-txt-2)] animate-fade-in-up leading-relaxed">
          <span className="font-medium text-[var(--color-txt-1)]">Tasks work in this browser: </span>
          checkboxes and &ldquo;My tasks&rdquo; are saved locally until the database is set up. Run{' '}
          <code className="text-[12px] px-1 rounded bg-[var(--color-stat)]">supabase-user-tasks.sql</code>{' '}
          in the Supabase SQL Editor so completions sync to your account across devices.
        </div>
      )}

      <div className="card p-4 sm:p-5 mb-6 border-[var(--color-border)] animate-fade-in-up stagger-1">
        <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">
          Add a task
        </div>
        <form onSubmit={handleAddManualTask} className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1 min-w-0">
            <label htmlFor="new-task-title" className="text-[11px] text-[var(--color-txt-3)] block mb-1">
              Title
            </label>
            <input
              id="new-task-title"
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Finish lab write-up"
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[14px] text-[var(--color-txt-0)] placeholder:text-[var(--color-txt-3)]"
            />
          </div>
          <div className="w-full sm:w-44 shrink-0">
            <label htmlFor="new-task-due" className="text-[11px] text-[var(--color-txt-3)] block mb-1">
              Due date
            </label>
            <input
              id="new-task-due"
              type="date"
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[14px] text-[var(--color-txt-0)]"
            />
          </div>
          <button
            type="submit"
            disabled={addSubmitting || !newTitle.trim()}
            className="btn btn-primary text-[13px] px-5 py-2.5 w-full sm:w-auto shrink-0 disabled:opacity-40"
          >
            {addSubmitting ? 'Adding…' : 'Add task'}
          </button>
        </form>
      </div>

      {hasNoSources && (
        <div className="card p-5 mb-6 border-[var(--color-gold)]/30 bg-[var(--color-gold)]/8 animate-fade-in-up">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="text-[16px] font-semibold text-[var(--color-txt-0)]">
                Connect your Brightspace calendar
              </div>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-1 max-w-[640px]">
                Import your assignments, exams, and due dates from Brightspace to see them here.
              </p>
            </div>
            <Link to="/setup" className="btn btn-primary text-[13px] px-5 py-2.5 w-fit">
              <Icon name="calendar" size={15} />
              Connect Brightspace
            </Link>
          </div>
        </div>
      )}

      {categoriesWithManual.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6 animate-fade-in-up stagger-1">
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
          <span className="w-px self-stretch bg-[var(--color-border)] mx-1" aria-hidden="true" />
          {PRIORITY_LEVELS.map((level) => {
            const isActive = priorityFilter === level
            return (
              <button
                key={level}
                onClick={() => setPriorityFilter(isActive ? null : level)}
                className={`pill whitespace-nowrap inline-flex items-center gap-1.5 ${isActive ? 'pill-active' : ''}`}
                title={`Show only ${priorityConfig[level].label.toLowerCase()} priority tasks`}
              >
                <Icon name="flag" size={11} className={priorityConfig[level].text} />
                {priorityConfig[level].label}
              </button>
            )
          })}
        </div>
      )}

      {/* AI Insights Panel */}
      {!hasNoSources && !loading && filteredItems.length > 0 && (
        <div className={`card mb-6 transition-all duration-300 border-[var(--color-gold)]/20 animate-fade-in-up stagger-2 ${insightsOpen ? '' : 'cursor-pointer'}`}>
          <div
            className="flex items-center justify-between gap-3 p-4 cursor-pointer"
            onClick={() => setInsightsOpen((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center shrink-0">
                <Icon name="sparkles" size={12} className="text-[var(--color-gold-dark)]" />
              </div>
              <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">AI Insights</span>
            </div>
            <Icon name={insightsOpen ? 'chevronUp' : 'chevronDown'} size={14} className="text-[var(--color-txt-3)]" />
          </div>
          {insightsOpen && (
            <div className="px-4 pb-4">
              <div className="flex items-center gap-2 mb-3">
                {['priority', 'study'].map((m) => (
                  <button
                    key={m}
                    onClick={() => setInsightsMode(m)}
                    className={`text-[11px] font-medium px-3 py-1.5 rounded-full transition-all ${
                      insightsMode === m
                        ? 'bg-[var(--color-gold)]/15 text-[var(--color-gold-muted)]'
                        : 'bg-[var(--color-stat)] text-[var(--color-txt-2)] hover:bg-[var(--color-bg-3)]'
                    }`}
                  >
                    {m === 'priority' ? 'Priority Ranking' : 'Study Plan'}
                  </button>
                ))}
                <button
                  onClick={() => generateInsights(insightsMode)}
                  disabled={insightsLoading}
                  className="ml-auto text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-40 shrink-0"
                >
                  {insightsLoading ? 'Generating…' : activeInsight ? 'Refresh' : 'Generate'}
                </button>
              </div>
              {insightsLoading && !activeInsight ? (
                <div className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)] py-2">
                  <div className="w-3.5 h-3.5 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin shrink-0" />
                  Analyzing your assignments…
                </div>
              ) : activeInsight ? (
                <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed whitespace-pre-line">{activeInsight}</p>
              ) : (
                <p className="text-[12px] text-[var(--color-txt-3)] py-1">
                  Click &ldquo;Generate&rdquo; to get AI-powered {insightsMode === 'priority' ? 'priority ranking' : 'study plan'} based on your schedule and deadlines.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-[var(--color-txt-2)]">
          Loading assignments...
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="card p-8 text-center">
          <Icon name="calendar" size={32} className="mx-auto text-[var(--color-txt-3)] mb-3" />
          <div className="text-[var(--color-txt-1)] font-medium">No items found</div>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">
            {hasNoSources 
              ? 'Connect your Brightspace calendar to see assignments and events.'
              : selectedCategories.length > 0 
                ? 'Try selecting different categories or showing past items.'
                : 'No upcoming assignments or events.'}
          </p>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[1fr_340px] gap-6">
          <div className="space-y-6 animate-fade-in-up stagger-2">
            {Object.entries(groupedItems).map(([date, dateItems]) => (
              <div key={date}>
                <div className="text-[12px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">
                  {date}
                </div>
                <div className="space-y-2">
                  {dateItems.map(item => {
                    const config = categoryConfig[item.category ?? ''] || categoryConfig.event
                    const isSelected = selectedItem?.id === item.id
                    const past = isPastDue(item.startTime)
                    
                    return (
                      <div
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedItem(item)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setSelectedItem(item)
                          }
                        }}
                        className={`w-full text-left card-interactive p-4 transition-all cursor-pointer ${
                          isSelected ? 'ring-2 ring-[var(--color-gold)]' : ''
                        } ${past && !item.completed ? 'opacity-60' : ''} ${item.completed ? 'opacity-90' : ''}`}
                      >
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={(e) => toggleItemComplete(item, !item.completed, e)}
                            className={`shrink-0 mt-0.5 w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-colors ${
                              item.completed
                                ? 'bg-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-bg-0)]'
                                : 'border-[var(--color-border-2)] hover:border-[var(--color-accent)] bg-[var(--color-surface)]'
                            }`}
                            aria-label={item.completed ? 'Mark as not done' : 'Mark as done'}
                          >
                            {item.completed ? <Icon name="check" size={14} /> : null}
                          </button>
                          <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${config.text.replace('text-', 'bg-')}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <div
                                className={`font-medium text-[14px] line-clamp-2 ${
                                  item.completed
                                    ? 'line-through text-[var(--color-txt-3)]'
                                    : 'text-[var(--color-txt-0)]'
                                }`}
                              >
                                {item.title}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {item.priority && (
                                  <span
                                    className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${priorityConfig[item.priority].bg} ${priorityConfig[item.priority].text}`}
                                  >
                                    <Icon name="flag" size={10} />
                                    {priorityConfig[item.priority].label}
                                  </span>
                                )}
                                <span className={`text-[11px] px-2 py-0.5 rounded-full ${config.bg} ${config.text}`}>
                                  {config.label}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-3 mt-1.5 text-[12px] text-[var(--color-txt-2)]">
                              <span className="flex items-center gap-1">
                                <Icon name="clock" size={12} />
                                {formatTime(item.startTime)}
                              </span>
                              {item.location && (
                                <span className="flex items-center gap-1 truncate">
                                  <Icon name="mapPin" size={12} />
                                  {item.location.split(' (')[0]}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="lg:sticky lg:top-24 h-fit min-w-0 animate-fade-in-up stagger-3">
            {selectedItem ? (
              <div className="card p-5 min-w-0 overflow-hidden">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div>
                    <span className={`text-[11px] px-2.5 py-1 rounded-full ${
                      (categoryConfig[selectedItem.category ?? ''] || categoryConfig.event).bg
                    } ${(categoryConfig[selectedItem.category ?? ''] || categoryConfig.event).text}`}>
                      {(categoryConfig[selectedItem.category ?? ''] || categoryConfig.event).label}
                    </span>
                  </div>
                  <button 
                    onClick={() => setSelectedItem(null)}
                    className="text-[var(--color-txt-3)] hover:text-[var(--color-txt-1)]"
                  >
                    <Icon name="close" size={18} />
                  </button>
                </div>
                
                <h3
                  className={`text-[18px] font-semibold mb-4 ${
                    selectedItem.completed ? 'line-through text-[var(--color-txt-3)]' : 'text-[var(--color-txt-0)]'
                  }`}
                >
                  {selectedItem.title}
                </h3>

                <div className="mb-5">
                  <div className="text-[12px] font-medium text-[var(--color-txt-3)] uppercase tracking-wider mb-2">
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
                          className={`inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-xl border transition-all ${
                            isActive
                              ? `${priorityConfig[level].bg} ${priorityConfig[level].text} ${priorityConfig[level].border}`
                              : 'border-[var(--color-border)] text-[var(--color-txt-2)] hover:border-[var(--color-border-2)]'
                          }`}
                        >
                          <Icon name="flag" size={11} />
                          {priorityConfig[level].label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 mb-5">
                  <button
                    type="button"
                    onClick={() => toggleItemComplete(selectedItem, !selectedItem.completed)}
                    className="btn btn-secondary text-[12px] px-3 py-1.5"
                  >
                    {selectedItem.completed ? 'Mark not done' : 'Mark done'}
                  </button>
                  {selectedItem.isManual && (
                    <button
                      type="button"
                      onClick={() => deleteManualTask(selectedItem.id)}
                      className="text-[12px] px-3 py-1.5 rounded-xl border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10"
                    >
                      Delete task
                    </button>
                  )}
                </div>
                
                <div className="space-y-3 mb-5">
                  <div className="flex items-center gap-3 text-[13px]">
                    <div className="w-8 h-8 rounded-lg bg-[var(--color-bg-2)] flex items-center justify-center">
                      <Icon name="calendar" size={15} className="text-[var(--color-txt-2)]" />
                    </div>
                    <div>
                      <div className="text-[var(--color-txt-1)]">{formatDate(selectedItem.startTime)}</div>
                      <div className="text-[var(--color-txt-3)] text-[12px]">{formatTime(selectedItem.startTime)}</div>
                    </div>
                  </div>
                  
                  {selectedItem.location && (
                    <div className="flex items-start gap-3 text-[13px] min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-[var(--color-bg-2)] flex items-center justify-center shrink-0">
                        <Icon name="mapPin" size={15} className="text-[var(--color-txt-2)]" />
                      </div>
                      <div className="text-[var(--color-txt-1)] min-w-0 break-words [overflow-wrap:anywhere]">
                        {/^https?:\/\//i.test(selectedItem.location.trim()) ? (
                          <a
                            href={selectedItem.location.trim()}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--color-accent)] hover:underline break-all"
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
                  
                  <div className="flex items-center gap-3 text-[13px]">
                    <div className="w-8 h-8 rounded-lg bg-[var(--color-bg-2)] flex items-center justify-center">
                      <Icon name="clock" size={15} className="text-[var(--color-txt-2)]" />
                    </div>
                    <div>
                      <div className={`${isPastDue(selectedItem.startTime) ? 'text-[var(--color-error)]' : 'text-[var(--color-txt-1)]'}`}>
                        {isPastDue(selectedItem.startTime) ? 'Past due' : `Due in ${getRelativeTime(selectedItem.startTime)}`}
                      </div>
                    </div>
                  </div>
                </div>
                
                {selectedItem.description && (
                  <div className="pt-4 border-t border-[var(--color-border)] min-w-0">
                    <div className="text-[12px] font-medium text-[var(--color-txt-3)] uppercase tracking-wider mb-2">
                      Description
                    </div>
                    <div className="text-[13px] text-[var(--color-txt-1)] leading-relaxed min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
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
              <div className="card p-5 text-center text-[var(--color-txt-2)]">
                <Icon name="document" size={24} className="mx-auto mb-2 text-[var(--color-txt-3)]" />
                <p className="text-[13px]">Select an item to view details</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
