import { test as base, expect } from '@playwright/test'
import { defaultLayout, normalizeLayout } from '../../src/dashboardLayout.mjs'
import {
  defaultLayout as defaultServicesLayout,
  normalizeLayout as normalizeServicesLayout,
} from '../../src/servicesLayout.mjs'

// Stateful, in-memory mock of the BoilerIndy backend. Each test gets a fresh
// `mockApi` controller that intercepts every `/api/**` call (and the Supabase
// SDK's `**/auth/v1/**` calls) so flows are deterministic and offline. The
// payload shapes mirror server.mjs: see buildSessionPayload, listCalendarItems,
// getClassItemsForUser, and mapManualTaskRow.

const DEFAULT_USER = {
  id: 'e2e-user-1',
  email: 'student@purdue.edu',
  name: 'Test Student',
  authProvider: 'local',
  purdueEmail: 'student@purdue.edu',
  purdueUsername: null,
  hasPurdueLinked: true,
}

const DEFAULT_CREDENTIALS = { email: 'student@purdue.edu', password: 'correct-horse-battery' }

function defaultOnboarding(overrides = {}) {
  return {
    linkedSourceCount: 1,
    classCount: 5,
    hasPurdueLinked: true,
    needsPurdueConnection: false,
    needsScheduleSource: false,
    ...overrides,
  }
}

function sessionPayload(state) {
  return {
    expiresAt: null,
    user: { ...state.user },
    onboarding: state.onboarding,
  }
}

// Mirrors server.mjs mapManualTaskRow: due_at surfaces as startTime.
function mapManualTask(task) {
  return {
    id: task.id,
    title: task.title,
    startTime: task.due_at,
    endTime: null,
    category: 'manual_task',
    sourceType: 'manual',
    description: null,
    location: null,
    externalUid: null,
    sourceId: null,
    completedAt: task.completed_at,
    isManual: true,
  }
}

export const test = base.extend({
  mockApi: async ({ context }, use) => {
    const state = {
      loggedIn: false,
      user: { ...DEFAULT_USER },
      onboarding: defaultOnboarding(),
      credentials: { ...DEFAULT_CREDENTIALS },
      classes: [],
      classesMeta: { selectedTermKey: null, selectedTermLabel: '', totalInTerm: 0 },
      calendarItems: [],
      categories: [],
      manualTasks: [],
      completions: [],
      feedUrl: null,
      // null === never customized; the GET handler then returns the default.
      dashboardLayout: null,
      servicesLayout: null,
      // Grade tracker (#10) + degree planner (#18).
      grades: [],
      gradeSeq: 0,
      major: null,
    }

    const json = (route, status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    // Supabase JS SDK token/refresh calls - kept offline so getSession() and the
    // non-blocking signInWithEmail() in Login.jsx resolve fast and predictably.
    // /recover (resetPasswordForEmail) succeeds so the forgot-password flow is
    // testable; everything else stays disabled.
    await context.route('**/auth/v1/**', (route) => {
      const { pathname } = new URL(route.request().url())
      if (pathname.endsWith('/auth/v1/recover')) {
        return json(route, 200, {})
      }
      return json(route, 400, { error: 'supabase-disabled-in-e2e' })
    })

    await context.route('**/api/**', async (route) => {
      const req = route.request()
      const { pathname } = new URL(req.url())
      const method = req.method()
      const bodyOf = () => {
        try {
          return req.postDataJSON() || {}
        } catch {
          return {}
        }
      }

      if (pathname === '/api/auth-config') {
        return json(route, 200, { authProvider: 'local', purdueAuthMode: 'mock' })
      }

      if (pathname === '/api/session') {
        return json(route, 200, {
          authenticated: state.loggedIn,
          session: state.loggedIn ? sessionPayload(state) : null,
        })
      }

      if (pathname === '/api/auth/sign-in' && method === 'POST') {
        const { email, password } = bodyOf()
        if (email === state.credentials.email && password === state.credentials.password) {
          state.loggedIn = true
          return json(route, 200, { session: sessionPayload(state) })
        }
        return json(route, 401, { error: { message: 'Invalid email or password.', status: 401 } })
      }

      if (pathname === '/api/auth/register-supabase' && method === 'POST') {
        const { email, name } = bodyOf()
        state.user = { ...state.user, email: email || state.user.email, name: name || state.user.name }
        state.loggedIn = true
        return json(route, 200, { session: sessionPayload(state) })
      }

      if (pathname === '/api/auth/supabase-sync') {
        return json(route, 200, { session: state.loggedIn ? sessionPayload(state) : null })
      }

      if (pathname === '/api/sign-out') {
        state.loggedIn = false
        return json(route, 200, { ok: true })
      }

      if (pathname === '/api/me/classes') {
        return json(route, 200, { items: state.classes, meta: state.classesMeta })
      }

      if (pathname === '/api/me/calendar') {
        return json(route, 200, { items: state.calendarItems })
      }

      if (pathname === '/api/me/calendar/categories') {
        return json(route, 200, { categories: state.categories })
      }

      if (pathname === '/api/me/tasks/meta') {
        return json(route, 200, {
          completions: state.completions,
          manualTasks: state.manualTasks.map(mapManualTask),
        })
      }

      if (pathname === '/api/me/tasks/manual' && method === 'POST') {
        const { title, dueAt } = bodyOf()
        const task = {
          id: `task-${state.manualTasks.length + 1}-${Date.now()}`,
          title,
          due_at: dueAt ?? null,
          completed_at: null,
        }
        state.manualTasks.push(task)
        return json(route, 200, { task: mapManualTask(task) })
      }

      const manualMatch = pathname.match(/^\/api\/me\/tasks\/manual\/(.+)$/)
      if (manualMatch && method === 'PATCH') {
        const task = state.manualTasks.find((t) => t.id === manualMatch[1])
        if (task) task.completed_at = bodyOf().completed ? new Date().toISOString() : null
        return json(route, 200, { ok: true })
      }
      if (manualMatch && method === 'DELETE') {
        state.manualTasks = state.manualTasks.filter((t) => t.id !== manualMatch[1])
        return json(route, 200, { ok: true })
      }

      if (pathname === '/api/me/tasks/calendar/complete' && method === 'POST') {
        const { calendarItemId, completed } = bodyOf()
        if (completed) {
          state.completions.push({ calendar_item_id: calendarItemId, completed_at: new Date().toISOString() })
        } else {
          state.completions = state.completions.filter((c) => c.calendar_item_id !== calendarItemId)
        }
        return json(route, 200, { ok: true })
      }

      // Customizable home dashboard layout (issue #52). Mirrors server.mjs:
      // GET returns the saved layout (or default), PUT sanitizes + stores it so
      // the change survives a page reload within the test.
      if (pathname === '/api/me/dashboard' && method === 'GET') {
        const layout = state.dashboardLayout == null ? defaultLayout() : normalizeLayout(state.dashboardLayout)
        return json(route, 200, { layout })
      }
      if (pathname === '/api/me/dashboard' && method === 'PUT') {
        state.dashboardLayout = normalizeLayout(bodyOf().layout)
        return json(route, 200, { layout: state.dashboardLayout })
      }

      // Customizable Student Services board layout. Mirrors /api/me/dashboard:
      // GET returns the saved layout (or default), PUT sanitizes + stores it.
      if (pathname === '/api/me/services' && method === 'GET') {
        const layout = state.servicesLayout == null ? defaultServicesLayout() : normalizeServicesLayout(state.servicesLayout)
        return json(route, 200, { layout })
      }
      if (pathname === '/api/me/services' && method === 'PUT') {
        state.servicesLayout = normalizeServicesLayout(bodyOf().layout)
        return json(route, 200, { layout: state.servicesLayout })
      }

      // Grade tracker (#10): user-scoped course CRUD. Shapes mirror
      // server.mjs mapGradeRow / parseGradeBody.
      if (pathname === '/api/me/grades' && method === 'GET') {
        return json(route, 200, { grades: state.grades })
      }
      if (pathname === '/api/me/grades' && method === 'POST') {
        const b = bodyOf()
        const grade = {
          id: `grade-${++state.gradeSeq}`,
          courseName: String(b.courseName || '').trim(),
          term: String(b.term || '').trim() || 'Other',
          creditHours: Number(b.creditHours ?? 3),
          letterGrade: String(b.letterGrade || ''),
        }
        state.grades.push(grade)
        return json(route, 200, { grade })
      }
      const gradeMatch = pathname.match(/^\/api\/me\/grades\/(.+)$/)
      if (gradeMatch && method === 'PATCH') {
        const grade = state.grades.find((g) => g.id === gradeMatch[1])
        if (!grade) return json(route, 404, { error: { message: 'Course not found' } })
        const b = bodyOf()
        if (b.courseName != null) grade.courseName = String(b.courseName).trim()
        if (b.term != null) grade.term = String(b.term).trim() || 'Other'
        if (b.creditHours != null) grade.creditHours = Number(b.creditHours)
        if (b.letterGrade != null) grade.letterGrade = String(b.letterGrade)
        return json(route, 200, { grade })
      }
      if (gradeMatch && method === 'DELETE') {
        state.grades = state.grades.filter((g) => g.id !== gradeMatch[1])
        return json(route, 200, { ok: true })
      }

      // Degree planner (#18): selected major.
      if (pathname === '/api/me/degree' && method === 'GET') {
        return json(route, 200, { major: state.major })
      }
      if (pathname === '/api/me/degree' && method === 'PUT') {
        state.major = bodyOf().major || null
        return json(route, 200, { major: state.major })
      }

      if (pathname === '/api/me/calendar-feed' && method === 'GET') {
        return json(route, 200, { feedUrl: state.feedUrl })
      }
      if (pathname === '/api/me/calendar-feed/token' && method === 'POST') {
        state.feedUrl = 'http://localhost:4173/feeds/calendar/11111111-1111-4111-8111-111111111111.ics'
        return json(route, 200, { feedUrl: state.feedUrl })
      }

      // Unmapped endpoints: a benign empty success so pages that fan out extra
      // reads (sources, profile, dining, transit) render instead of erroring.
      return json(route, 200, { items: [], ok: true })
    })

    const controller = {
      state,
      login() {
        state.loggedIn = true
      },
      logout() {
        state.loggedIn = false
      },
      setOnboarding(overrides) {
        state.onboarding = defaultOnboarding(overrides)
      },
      seedClasses(items, meta = {}) {
        state.classes = items
        state.classesMeta = { ...state.classesMeta, ...meta }
      },
      seedCategories(categories) {
        state.categories = categories
      },
      seedCalendarItems(items) {
        state.calendarItems = items
      },
      seedGrades(items) {
        state.grades = items.map((g, i) => ({
          id: g.id || `grade-seed-${i + 1}`,
          courseName: g.courseName,
          term: g.term || 'Other',
          creditHours: Number(g.creditHours ?? 3),
          letterGrade: g.letterGrade,
        }))
        state.gradeSeq = state.grades.length
      },
      setMajor(major) {
        state.major = major || null
      },
    }

    await use(controller)
  },
})

export { expect }
