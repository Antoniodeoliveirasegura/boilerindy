import express from 'express'
import {
  STUDY_HELP_DEADLINE_HOURS,
  buildDiningContext,
  calendarContextFor,
  startsWithin,
  wantsStudyHelp,
} from '../assistantContext.mjs'
import { estimateTokens, tidyAssistantReply } from '../assistantReply.mjs'
import {
  matchIntent,
  formatNextClass,
  formatClassesToday,
  formatDiningOpen,
  formatAssignments,
  intentFocusHint,
  ASSISTANT_OFFLINE_MESSAGE,
} from '../assistantRouter.mjs'
import { GroqUpstreamError } from '../groqClient.mjs'
import { applyScheduleOverridesToRows, manualClassesAsRows } from '../scheduleOverrides.mjs'

// The campus assistant. POST /api/assistant answers a chat turn through the
// Groq client, with the system prompt below and a context block built from the
// student's calendar, schedule edits, task list and today's dining, and GET
// /api/assistant/briefing builds the chat panel's opening line and suggested
// questions from the same data without a model call. Without GROQ_API_KEY the
// chat answers from the offline intent router (src/assistantRouter.mjs). Moved
// out of server.mjs as a feature router (issue #191) with the handlers
// unchanged apart from the GROQ_API_KEY check, which asks the client instead
// (ai.enabled), as in the board router.

const TZ = 'America/Indiana/Indianapolis'

const CAMPUS_SYSTEM_PROMPT = `You are BoilerIndy - a helpful campus assistant for Purdue University Indianapolis (Purdue Indy / IUPUI).
You have access to real-time data about the student's schedule, dining, and campus events - all provided in the context block below.
Use that data to answer questions directly and accurately. Do not tell the student to "check the app" or "check the tab" when the answer is already in the context.

You help students with:
- Their personal class schedule (including earlier today and what's in session), upcoming assignments, exams, and due dates (from context)
- Dining hours and today's menu at each location (from context)
- Campus / career / optional events (from context)
- Where to study and get help on campus (use the ON-CAMPUS STUDY & HELP section when it is present)
- Campus transit/buses: Crimson & Gray routes run Mon-Fri 6:30am-10pm; Yellow & Blue run Mon-Fri 5:30am-midnight; Purple runs Mon-Fri 7am-10pm; Orange runs Sat-Sun 9am-8pm
- Buildings: ET Building (engineering/tech), Campus Center (dining, student services), University Library, Science & Engineering Lab Building (SL), Cavanaugh Hall (CA), Hine Hall (HH), Madam Walker Legacy Center, IUPUI Tower
- Student services: ASC tutoring (Campus Center 2nd floor), printing (library 25 free pages/day), Health & Wellness Center, Financial Aid (Cavanaugh Hall), Registrar (Cavanaugh Hall)
- General student life at Purdue Indy

How to read the context block:
- COURSES, TODAY and HAPPENING NOW already reflect the student's own edits: classes they deleted are gone, times and rooms they corrected are applied, and classes they added by hand are included and marked [added by you]. Treat it as the truth. Never mention a class that is not listed.
- Anything marked [DONE] is already finished. Never tell the student to do it, and never count it as pending work.
- YOUR TASK LIST is the to-dos the student typed in themselves. It is just as real as synced coursework - weave both together rather than treating the synced list as the only one.
- Items marked [OVERDUE] are late. Call those out first when the student asks what to work on.

Formatting (the app renders your reply as markdown):
- Use "-" bullets for lists of classes, deadlines, menu items or steps. Never write a numbered plan as one long paragraph.
- Bold the thing that matters most in a line - a course code, a time, a deadline - with **double asterisks**. Do not bold whole sentences.
- No headings for short answers. Only use "###" when the reply genuinely has two or more distinct sections.
- Write times the way a person says them: "2:30pm", not "14:30" or "2:30 PM Eastern".
- Never output raw JSON, tables, code fences or a dump of the context block.

Rules:
- Be concise and friendly. For simple questions: 2-4 sentences, no bullets. For "what should I do now?", "plan my afternoon", or similar planning questions: a short prioritized list of 3-5 bullets, each one concrete and tied to a real time.
- Open with the answer. No "Sure!", no "Great question", no restating what they asked.
- Answer directly from the context data when available - do not hedge or defer.
- Refer to the student's own data specifically: name the course code, time and room exactly as the context lists them, rather than "you have a class this afternoon". Never name a course, time or room the context does not list.
- When the student asks what to do *now*, *next*, or how to balance their time: anchor on CURRENT DATE & TIME. Weigh together: (1) anything in HAPPENING NOW, (2) classes or exams starting within the next ~2 hours, (3) homework or projects due in the next 24-48 hours (especially tonight), (4) upcoming exams/quizzes that need prep time, (5) optional campus events. Do **not** push optional events over urgent coursework or tight deadlines unless they are clearly free.
- If homework is due tonight, say so and suggest when to work on it relative to class, meals, and events already on their calendar.
- For exam prep or heavy homework blocks, suggest concrete on-campus options from the STUDY & HELP section when it is present (e.g. library quiet floors, ET/SL for STEM, ASC tutoring for support - match to subject when possible).
- For "next class" questions only count regular lectures/labs/discussions, not exams or office hours (unless asked).
- If something is genuinely unknown (not in context and not general knowledge), say so briefly.
- If asked about something totally unrelated to campus life, briefly redirect.

Reply format (strict, overrides anything above):
- Plain text only. No markdown: no **bold**, no # headings, no tables. A short list with "- " lines is fine for 2 to 5 items.
- Keep it short. Simple question: one to three sentences, under 60 words. Planning question ("what should I do", "what's the play", "plan my afternoon"): at most 4 lines or 4 sentences, under 90 words, covering only the next few hours, most important thing first.
- Never use em dashes or en dashes. Use a comma, a period, or a plain hyphen.
- Lead with the answer. No greeting, no restating the question, no closing offer like "let me know if you need anything else".
- Use clock times like 12:15 PM and the real names from the context.`

// Shown in the chat when Groq answers 429: the free tier is capped per minute
// and per day for the whole organisation (issue #252), and a friendly line in
// the bubble beats a red error for something the student cannot fix.
const ASSISTANT_BUSY_MESSAGE =
  'The assistant is busy right now. Give it a minute and ask again, or check the Schedule, Dining and Transit tabs directly.'

// ── Context formatters ────────────────────────────────────────────────────────

function fmtTime(isoStr, opts = {}) {
  return new Date(isoStr).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', ...opts })
}
function fmtDate(isoStr) {
  return new Date(isoStr).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' })
}

function summarizeClassSchedule(classes) {
  const byName = new Map()
  for (const c of classes) {
    const name = c.title || 'Untitled'
    if (!byName.has(name)) byName.set(name, new Set())
    const day = new Date(c.start_time).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' })
    byName.get(name).add(day)
  }
  if (!byName.size) return 'No upcoming classes found.'
  return [...byName.entries()]
    .map(([name, days]) => `${name} (${[...days].join(', ')})`)
    .join('; ')
}

const ASSISTANT_ASSIGNMENT_CATEGORIES = new Set([
  'assignment', 'task', 'homework', 'submission', 'deadline', 'quiz', 'project',
  'paper', 'presentation', 'lab', 'midterm',
])

function isExamLikeCalendarRow(r) {
  const t = `${r.title || ''}`
  if (/\b(midterm|final|exam|quiz|test)\b/i.test(t)) return true
  return ['exam', 'quiz', 'midterm'].includes(r.category)
}

function isSameZonedCalendarDay(isoStr, refDate, timeZone) {
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return false
  const a = d.toLocaleDateString('en-CA', { timeZone })
  const b = refDate.toLocaleDateString('en-CA', { timeZone })
  return a === b
}

/**
 * Rich calendar context for /api/assistant: today, ongoing, exams, assignments,
 * events, and the study hints when `includeStudyHelp` (issue #253: questions
 * about studying, see wantsStudyHelp) or when homework or an exam falls in the
 * next 48 hours, since the prompt has the model plan study time around those.
 *
 * `completedIds` marks finished work instead of hiding it: the student may ask
 * "did I finish X?", but the model must stop recommending what is already done.
 */
function buildAssistantCalendarContext(calendarData, now, { includeStudyHelp = false, completedIds = new Set() } = {}) {
  if (!calendarData?.length) {
    return '=== CALENDAR ===\nNo calendar items in the fetched window.'
  }
  // Completed work still has to appear (the student may ask "did I finish X?"),
  // but it is labelled so the model stops recommending things already done.
  const doneMark = (row) => (completedIds.has(row.id) ? ' [DONE]' : '')
  const addedMark = (row) => (row.manual ? ' [added by you]' : '')

  const examTitleRe = /\b(midterm|final|exam|quiz|test)\b/i
  const nowMs = now.getTime()

  const classRows = calendarData.filter((r) => r.category === 'class' && !examTitleRe.test(r.title || ''))
  const assignmentRows = calendarData.filter((r) => ASSISTANT_ASSIGNMENT_CATEGORIES.has(r.category))
  const examRows = calendarData.filter((r) => isExamLikeCalendarRow(r))
  const eventRows = calendarData.filter((r) => ['event', 'campus_event', 'activity'].includes(r.category))

  const ongoing = calendarData.filter((r) => {
    if (!r.start_time || !r.end_time) return false
    const s = new Date(r.start_time).getTime()
    const e = new Date(r.end_time).getTime()
    return s <= nowMs && e > nowMs
  })

  const todayRows = calendarData
    .filter((r) => r.start_time && isSameZonedCalendarDay(r.start_time, now, TZ))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))

  const parts = []

  parts.push(`=== COURSES (meeting pattern from upcoming instances) ===\n${summarizeClassSchedule(classRows)}`)

  if (ongoing.length) {
    parts.push('=== HAPPENING NOW (in session) ===')
    parts.push(
      ongoing
        .map((i) => `- Until ${fmtTime(i.end_time)}: ${i.title} [${i.category}]${i.location ? ` @ ${i.location}` : ''}${addedMark(i)}`)
        .join('\n'),
    )
  }

  if (todayRows.length) {
    const dayLabel = now.toLocaleDateString('en-US', {
      timeZone: TZ,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    })
    parts.push(`=== TODAY (${dayLabel}) - everything with times (Eastern) ===`)
    parts.push(
      todayRows
        .map((i) => {
          const range = i.end_time
            ? `${fmtTime(i.start_time)}-${fmtTime(i.end_time)}`
            : fmtTime(i.start_time)
          return `- ${range}: ${i.title} [${i.category}]${i.location ? ` @ ${i.location}` : ''}${addedMark(i)}${doneMark(i)}`
        })
        .join('\n'),
    )
  }

  if (assignmentRows.length) {
    parts.push('=== UPCOMING ASSIGNMENTS / HOMEWORK / DEADLINES (from synced courses) ===')
    parts.push(
      assignmentRows
        .map((i) => `- Due ${fmtDate(i.start_time)} ${fmtTime(i.start_time)}: ${i.title}${i.location ? ` (${i.location})` : ''} [${i.category}]${doneMark(i)}`)
        .join('\n'),
    )
  } else {
    parts.push('=== UPCOMING ASSIGNMENTS / HOMEWORK / DEADLINES ===\nNone in the fetched window.')
  }

  if (examRows.length) {
    parts.push('=== UPCOMING EXAMS, QUIZZES & HIGH-STAKES DATES ===')
    parts.push(
      examRows
        .map((i) => `- ${fmtDate(i.start_time)} ${fmtTime(i.start_time)}: ${i.title}${i.location ? ` @ ${i.location}` : ''} [${i.category}]`)
        .join('\n'),
    )
  }

  if (eventRows.length) {
    parts.push('=== CAMPUS / CAREER / OPTIONAL EVENTS ===')
    parts.push(
      eventRows
        .map((i) => `- ${fmtDate(i.start_time)} ${fmtTime(i.start_time)}${i.location ? ` @ ${i.location}` : ''}: ${i.title}`)
        .join('\n'),
    )
  }

  if (includeStudyHelp || startsWithin([...assignmentRows, ...examRows], now, STUDY_HELP_DEADLINE_HOURS)) {
    parts.push(`=== ON-CAMPUS STUDY & HELP (suggest when relevant) ===
- University Library: quiet floors, study rooms, printing (25 free pages/day).
- ET Building & Science/Engineering Lab (SL): strong for STEM work between classes.
- Cavanaugh Hall & Hine Hall: lounges for shorter sessions.
- ASC tutoring: Campus Center 2nd floor - math, writing, coaching (check hours).
- Campus Center: food and space to regroup before/after events.`)
  }

  return parts.join('\n\n')
}

/** Tells the model which screen the student is looking at, when the client says. */
function describeAssistantPage(page) {
  if (typeof page !== 'string') return ''
  const label = ASSISTANT_PAGE_LABELS[page]
  if (!label) return ''
  return `=== WHERE THEY ARE ===\nThe student is on the ${label}. Prefer answers that are useful from this screen, and do not tell them to open the page they are already on.`
}

const ASSISTANT_PAGE_LABELS = {
  '/dashboard': 'dashboard',
  '/schedule': 'class schedule page',
  '/assignments': 'assignments and tasks page',
  '/dining': 'dining page',
  '/events': 'campus events page',
  '/board': 'campus board',
  '/transit': 'transit page',
  '/map': 'campus map',
  '/more': 'more / tools page',
  '/settings': 'settings page',
}

/**
 * The student's own to-do list (user_manual_tasks). These never lived in
 * calendar_items, which is why the assistant used to be blind to anything the
 * student added by hand.
 */
function buildManualTaskContext(tasks, now) {
  if (!tasks?.length) {
    return '=== YOUR TASK LIST (to-dos the student added by hand) ===\nEmpty - the student has not added any of their own tasks.'
  }
  const lines = tasks.map((t) => {
    const done = t.completed_at ? '[DONE] ' : ''
    if (!t.due_at) return `- ${done}${t.title} (no due date)`
    const overdue = !t.completed_at && new Date(t.due_at) < now ? ' [OVERDUE]' : ''
    return `- ${done}Due ${fmtDate(t.due_at)} ${fmtTime(t.due_at)}: ${t.title}${overdue}`
  })
  return `=== YOUR TASK LIST (to-dos the student added by hand) ===\n${lines.join('\n')}`
}

/**
 * The assistant routes, mounted by server.mjs where they used to be. Paths
 * stay absolute (`/api/assistant`) so docs/RATE_LIMITS.md and its guard test
 * read the same whether a route lives here or in server.mjs.
 *
 * @param {object}   deps
 * @param {object}   deps.supabase              the Supabase client
 * @param {Function} deps.requireAuth           loads req.currentUser or answers 401
 * @param {Function} deps.assistantRateLimit    the ai-assistant limiter, which skips itself without a Groq key
 * @param {object}   deps.ai                    the Groq client the board shares (src/groqClient.mjs);
 *   ai.enabled is false without GROQ_API_KEY, and the chat then answers offline
 * @param {Function} deps.warnAssistantBusy     server.mjs's warning for a 429 from both Groq models
 * @param {Function} deps.getDiningSnapshot     the cached Nutrislice snapshot (src/nutrisliceDining.mjs)
 * @param {Function} deps.getClassItemsForUser  server.mjs's class reader, for the offline class answers
 * @param {Function} deps.listCalendarItems     server.mjs's calendar reader, for the offline assignments answer
 * @param {Function} deps.readScheduleOverrides server.mjs's reader for the student's schedule edits
 */
export function createAssistantRouter({
  supabase,
  requireAuth,
  assistantRateLimit,
  ai,
  warnAssistantBusy,
  getDiningSnapshot,
  getClassItemsForUser,
  listCalendarItems,
  readScheduleOverrides,
}) {
  const router = express.Router()

  /**
   * Last-resort answers for when GROQ_API_KEY is missing. This is the templated
   * path that used to run for every matching question; it now only runs when
   * there is no model available at all.
   */
  async function buildOfflineAssistantReply(intent, userId, now) {
    if (intent === 'next_class' || intent === 'classes_today') {
      const { items } = await getClassItemsForUser(userId, { term: 'auto', limit: 50 })
      return intent === 'next_class' ? formatNextClass(items, now, TZ) : formatClassesToday(items, now, TZ)
    }
    if (intent === 'dining_open') {
      return formatDiningOpen(await getDiningSnapshot({}).catch(() => null))
    }
    if (intent === 'assignments') {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
      const items = await listCalendarItems(userId, {
        categories: [...ASSISTANT_ASSIGNMENT_CATEGORIES],
        limit: 50,
        order: 'asc',
        from: since,
      })
      return formatAssignments(items, now, TZ)
    }
    return null
  }

  /**
   * Everything the assistant knows about this student, assembled in parallel.
   *
   * Deliberately mirrors what the student sees in the UI: schedule overrides are
   * replayed and manually added classes injected, so the assistant cannot talk
   * about a class the student deleted or miss one they created.
   */
  async function gatherAssistantContext(userId, now) {
    const nowISOStr = now.toISOString()
    const lowerBound = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
    const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const sel = 'id, title, description, start_time, end_time, location, category'

    const [dining, calendar, taskMeta, overrides] = await Promise.all([
      getDiningSnapshot({}).catch(() => null),
      (async () => {
        const [upcomingRes, ongoingRes] = await Promise.all([
          supabase
            .from('calendar_items')
            .select(sel)
            .eq('user_id', userId)
            .gte('start_time', lowerBound)
            .lte('start_time', horizon)
            .order('start_time', { ascending: true })
            .limit(60),
          supabase
            .from('calendar_items')
            .select(sel)
            .eq('user_id', userId)
            .lt('start_time', nowISOStr)
            .gt('end_time', nowISOStr)
            .limit(25),
        ])
        const byId = new Map()
        for (const r of ongoingRes.data || []) byId.set(r.id, r)
        for (const r of upcomingRes.data || []) byId.set(r.id, r)
        return [...byId.values()]
      })().catch(() => []),
      (async () => {
        const [compRes, manualRes] = await Promise.all([
          supabase.from('user_task_completions').select('calendar_item_id').eq('user_id', userId),
          supabase
            .from('user_manual_tasks')
            .select('title, due_at, completed_at')
            .eq('user_id', userId)
            .order('due_at', { ascending: true })
            .limit(60),
        ])
        return {
          completedIds: new Set((compRes.data || []).map((r) => r.calendar_item_id)),
          manualTasks: manualRes.data || [],
        }
      })().catch(() => ({ completedIds: new Set(), manualTasks: [] })),
      readScheduleOverrides(userId).catch(() => ({ series: {}, manual: [] })),
    ])

    const corrected = applyScheduleOverridesToRows(calendar, overrides, TZ)
    const manualClasses = manualClassesAsRows(overrides.manual, new Date(lowerBound), new Date(horizon), TZ)
    const calendarRows = [...corrected, ...manualClasses].sort(
      (a, b) => new Date(a.start_time) - new Date(b.start_time),
    )

    return { dining, calendarRows, ...taskMeta }
  }

  router.post('/api/assistant', requireAuth, assistantRateLimit, async (req, res) => {
    const { messages } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' })
    }
    if (messages.length > 30) {
      return res.status(400).json({ error: 'Too many messages in one request.' })
    }
    for (const message of messages) {
      if (typeof message?.content === 'string' && message.content.length > 4000) {
        return res.status(400).json({ error: 'A message is too long.' })
      }
    }

    const lastUserMessage = [...messages].reverse().find((m) => m?.role === 'user')?.content || ''

    if (!ai.enabled) {
      // Without a key the formatters are the only thing that can answer, so this
      // is the one path where their templated output is still shown verbatim.
      const now = new Date()
      try {
        const routed = await buildOfflineAssistantReply(matchIntent(lastUserMessage), req.currentUser.id, now)
        if (routed) return res.json({ reply: routed, source: 'offline-router' })
      } catch {
        /* fall through to the generic offline notice */
      }
      return res.json({ reply: ASSISTANT_OFFLINE_MESSAGE, source: 'offline' })
    }

    const now = new Date()
    const nowLabel = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const timeLabel = now.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })

    const { dining, calendarRows, completedIds, manualTasks } = await gatherAssistantContext(
      req.currentUser.id,
      now,
    )

    // Prompt trim (issue #253): the study and help hints only for study questions
    // or a deadline in the next 48 hours. The dining trim is applied where the
    // context block is assembled, so it sees the question too.
    const includeStudyHelp = wantsStudyHelp(lastUserMessage)
    // A matched intent no longer answers for the model, it just tells it which
    // section to lead with.
    const focusHint = intentFocusHint(matchIntent(lastUserMessage))
    const pageHint = describeAssistantPage(req.body?.page)

    const contextBlock = [
      `=== CURRENT DATE & TIME ===\n${nowLabel} at ${timeLabel} (Eastern)`,
      pageHint,
      buildDiningContext(dining, { now, question: lastUserMessage }),
      calendarContextFor(calendarRows, (rows) => buildAssistantCalendarContext(rows, now, { includeStudyHelp, completedIds })),
      buildManualTaskContext(manualTasks, now),
      focusHint ? `=== WHAT THEY ARE ASKING ABOUT ===\n${focusHint}` : '',
    ].filter(Boolean).join('\n\n')

    const systemPrompt = CAMPUS_SYSTEM_PROMPT + '\n\n' + contextBlock
    const promptText = [systemPrompt, ...messages.map((m) => (typeof m?.content === 'string' ? m.content : ''))].join('\n')
    console.debug(`[assistant] prompt ~${estimateTokens(promptText)} tokens`)

    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }))

    try {
      // 2800 completion tokens rather than the 600 the router-era prompt needed:
      // the model now writes every reply, including the 3-5 bullet planning lists
      // the format rules allow, and low-effort reasoning tokens count against it.
      const text = await ai.reply({
        system: systemPrompt,
        messages: history,
        maxOutputTokens: 2800,
        temperature: 0.52,
      })
      // Plain text for the bubble whatever the model did (issue #252).
      res.json({ reply: tidyAssistantReply(text) ?? "Sorry, I couldn't generate a response." })
    } catch (err) {
      if (err instanceof GroqUpstreamError && err.status === 429) {
        // Both the primary and the fallback model answered 429 (the client retries once).
        warnAssistantBusy(err)
        return res.json({ reply: ASSISTANT_BUSY_MESSAGE, source: 'busy' })
      }
      if (err instanceof GroqUpstreamError) {
        console.error('Groq error:', err.body)
        return res.status(502).json({ error: 'AI service error' })
      }
      console.error('Assistant error:', err)
      res.status(500).json({ error: 'Assistant request failed' })
    }
  })

  /**
   * Opening state for the chat panel: what is actually going on right now, plus
   * suggested questions that match it.
   *
   * Deliberately NOT a model call. The panel used to greet everyone with the same
   * hardcoded sentence and the same five fixed chips, which is what made it read
   * as a generic chat box. This is real data, rendered deterministically, so it is
   * instant and free - the model still writes every actual answer.
   */
  router.get('/api/assistant/briefing', requireAuth, async (req, res) => {
    const now = new Date()
    try {
      const { dining, calendarRows, completedIds, manualTasks } = await gatherAssistantContext(
        req.currentUser.id,
        now,
      )

      const isDone = (row) => completedIds.has(row.id)
      const classesLeftToday = calendarRows.filter(
        (r) => r.category === 'class' && isSameZonedCalendarDay(r.start_time, now, TZ) && new Date(r.start_time) > now,
      )
      const inSession = calendarRows.find(
        (r) => r.start_time && r.end_time && new Date(r.start_time) <= now && new Date(r.end_time) > now,
      )

      const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      const dueThisWeek = calendarRows.filter(
        (r) =>
          ASSISTANT_ASSIGNMENT_CATEGORIES.has(r.category) &&
          !isDone(r) &&
          new Date(r.start_time) >= now &&
          new Date(r.start_time) <= weekOut,
      )
      const openTasks = manualTasks.filter((t) => !t.completed_at)
      const overdue = openTasks.filter((t) => t.due_at && new Date(t.due_at) < now)
      const openDining = (dining?.locations || []).filter((l) => l.is_open)

      const facts = []
      if (inSession) facts.push(`${inSession.title} until ${fmtTime(inSession.end_time)}`)
      else if (classesLeftToday.length) {
        const next = classesLeftToday[0]
        facts.push(`${next.title} at ${fmtTime(next.start_time)}`)
      }
      const pending = dueThisWeek.length + openTasks.length
      if (pending) facts.push(`${pending} thing${pending === 1 ? '' : 's'} on your plate`)
      if (overdue.length) facts.push(`${overdue.length} overdue`)

      const chips = []
      if (classesLeftToday.length || inSession) chips.push("What's my next class?")
      if (overdue.length) chips.push("What am I behind on?")
      if (dueThisWeek.length || openTasks.length) chips.push('What should I work on tonight?')
      chips.push('What should I do right now?')
      if (openDining.length) chips.push("What's good at dining right now?")
      chips.push('Plan my week')

      res.json({
        headline: facts.length ? facts.join(' · ') : 'Nothing scheduled right now',
        chips: chips.slice(0, 5),
      })
    } catch (e) {
      console.error('GET /api/assistant/briefing:', e?.message || e)
      // The panel falls back to a plain greeting; never block opening the chat.
      res.json({ headline: '', chips: [] })
    }
  })

  return router
}
