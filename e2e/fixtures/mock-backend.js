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

// Web Push (#9). config mirrors GET /api/push/config; notConfigured makes
// GET /api/push/settings answer the 503 the server sends before the push
// tables exist. Subscriptions keep their endpoint so DELETE can match them.
function defaultPush(overrides = {}) {
  return {
    config: { enabled: true, publicKey: 'BNo-real-key-just-for-tests', ...(overrides.config || {}) },
    settings: { deadlineReminders: true, leadMinutes: 60, ...(overrides.settings || {}) },
    subscriptions: (overrides.subscriptions || []).map((s, i) => ({
      id: s.id || `push-seed-${i + 1}`,
      endpoint: s.endpoint || `https://push.example/seed/${i + 1}`,
      createdAt: s.createdAt || new Date().toISOString(),
      userAgent: s.userAgent ?? null,
      lastUsedAt: s.lastUsedAt ?? null,
    })),
    notConfigured: overrides.notConfigured === true,
  }
}

// Club directory (#16): six organizations, three of them Indianapolis groups,
// in the club shape src/boilerlinkClubs.mjs produces. searchSampleClubs applies
// the same scope / category / q / paging rules as GET /api/clubs.
function sampleClub(overrides) {
  return {
    id: '1',
    name: 'Chess Club Purdue Indianapolis',
    shortName: 'Chess Club',
    slug: 'indychess',
    url: 'https://boilerlink.purdue.edu/organization/indychess',
    imageUrl: null,
    blurb: 'Weekly meetings for players of every level, plus a casual ladder and trips to regional tournaments.',
    categories: ['Athletic and Recreation', 'Club Sports', 'Hobby'],
    indianapolis: true,
    ...overrides,
  }
}

const TINY_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

export function sampleClubs() {
  return [
    sampleClub(),
    sampleClub({
      id: '2',
      name: 'Computer Science Club (Indianapolis)',
      shortName: 'CS Club',
      slug: 'computerscienceclub',
      url: 'https://boilerlink.purdue.edu/organization/computerscienceclub',
      imageUrl: TINY_GIF,
      blurb: 'Talks, hackathons and study jams for anyone who writes code.',
      categories: ['Computer and Technical-Based Interest', 'Pre-Professional'],
    }),
    sampleClub({
      id: '3',
      name: 'Run Club of Purdue in Indianapolis',
      shortName: null,
      slug: 'runclubindianapolis',
      url: 'https://boilerlink.purdue.edu/organization/runclubindianapolis',
      blurb: 'Easy group runs along the canal three mornings a week.',
      categories: ['Athletic and Recreation', 'Club Sports'],
    }),
    sampleClub({
      id: '4',
      name: 'Boiler Robotics Club',
      shortName: 'BRC',
      slug: 'boilerrobotics',
      url: 'https://boilerlink.purdue.edu/organization/boilerrobotics',
      imageUrl: TINY_GIF,
      blurb: 'Build and compete with autonomous robots.',
      categories: ['Computer and Technical-Based Interest', 'Hobby'],
      indianapolis: false,
    }),
    sampleClub({
      id: '5',
      name: 'Dance Marathon',
      shortName: 'PUDM',
      slug: 'dancemarathon',
      url: 'https://boilerlink.purdue.edu/organization/dancemarathon',
      blurb: 'A year of fundraising for Riley Hospital for Children, ending in an 18-hour marathon.',
      categories: ['Community Service & Civic Engagement', 'Dance'],
      indianapolis: false,
    }),
    sampleClub({
      id: '6',
      name: 'Purdue Sailing Club',
      shortName: null,
      slug: 'sailing',
      url: 'https://boilerlink.purdue.edu/organization/sailing',
      blurb: 'Learn to sail at Eagle Creek, no experience needed.',
      categories: ['Athletic and Recreation', 'Club Sports'],
      indianapolis: false,
    }),
  ]
}

const CLUBS_SOURCE_URL = 'https://boilerlink.purdue.edu/api/discovery/search/organizations'

function searchSampleClubs(clubs, searchParams) {
  const q = (searchParams.get('q') || '').trim().toLowerCase()
  const category = (searchParams.get('category') || '').trim()
  const scope = searchParams.get('scope') === 'indianapolis' ? 'indianapolis' : 'all'
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize')) || 24))
  const sorted = [...clubs].sort((a, b) => a.name.localeCompare(b.name))
  const matches = sorted.filter((c) => {
    if (scope === 'indianapolis' && !c.indianapolis) return false
    if (category && !c.categories.some((name) => name.toLowerCase() === category.toLowerCase())) return false
    if (q && !`${c.name} ${c.shortName || ''} ${c.blurb} ${c.categories.join(' ')}`.toLowerCase().includes(q)) return false
    return true
  })
  const pages = Math.max(1, Math.ceil(matches.length / pageSize))
  const page = Math.min(pages, Math.max(1, Number(searchParams.get('page')) || 1))
  const counts = new Map()
  for (const c of sorted) {
    for (const name of c.categories) {
      const row = counts.get(name) || { name, count: 0, indianapolisCount: 0 }
      row.count += 1
      if (c.indianapolis) row.indianapolisCount += 1
      counts.set(name, row)
    }
  }
  return {
    ok: true,
    source: 'boilerlink-organizations',
    sourceUrl: CLUBS_SOURCE_URL,
    fetchedAt: '2026-09-08T12:00:00.000Z',
    stale: false,
    directoryTotal: sorted.length,
    indianapolisTotal: sorted.filter((c) => c.indianapolis).length,
    q,
    category,
    scope,
    page,
    pageSize,
    pages,
    total: matches.length,
    clubs: matches.slice((page - 1) * pageSize, page * pageSize),
    categories: [...counts.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function degradedSampleClubs(searchParams) {
  return {
    ok: false,
    error: 'timeout',
    source: 'boilerlink-organizations',
    sourceUrl: CLUBS_SOURCE_URL,
    fetchedAt: '2026-09-08T12:00:00.000Z',
    stale: false,
    directoryTotal: 0,
    indianapolisTotal: 0,
    q: (searchParams.get('q') || '').trim(),
    category: (searchParams.get('category') || '').trim(),
    scope: searchParams.get('scope') === 'indianapolis' ? 'indianapolis' : 'all',
    page: 1,
    pageSize: 24,
    pages: 1,
    total: 0,
    clubs: [],
    categories: [],
  }
}

// Marketplace (#32) with listing photos (#171): three listings in the
// mapListingRow shape, one of them the test user's own and one with a photo.
// The seeded photo is an opaque 1x1 PNG so it visibly covers the category tile.
const SAMPLE_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPcrLvzPwAFrAK6Ojz5GwAAAABJRU5ErkJggg=='

function sampleListing(overrides) {
  return {
    id: 'listing-1',
    title: 'Calculus textbook, 9th edition',
    description: 'Barely used, no highlights.',
    category: 'textbooks',
    priceCents: 4500,
    imageUrl: SAMPLE_PHOTO,
    status: 'active',
    createdAt: '2026-09-07T12:00:00.000Z',
    isMine: false,
    ...overrides,
  }
}

export function sampleListings() {
  return [
    sampleListing(),
    sampleListing({ id: 'listing-2', title: 'Desk lamp', description: 'Warm white LED.', category: 'furniture', priceCents: 1250, imageUrl: null, isMine: true }),
    sampleListing({ id: 'listing-3', title: 'Bus pass, spring', description: '', category: 'rideshare', priceCents: 0, imageUrl: null }),
  ]
}

// Where the mock "bucket" serves uploaded photos from; the context-level Storage
// routes below answer the signed PUT and the public GET for this prefix.
const STORAGE_PUBLIC_BASE = 'https://e2e.supabase.test/storage/v1/object/public/marketplace-images'

function defaultMarketplace() {
  return {
    listings: sampleListings(),
    listingSeq: 3,
    photoSeq: 0,
    // receipt -> { path, byteSize, listingId }, issued by the authorize route.
    receipts: new Map(),
    // path -> byte count, recorded by the mocked signed PUT.
    uploads: new Map(),
    photosUnavailable: false,
    failNextUpload: false,
    // Every create / edit body the page sent, for assertions on the wire shape.
    bodies: [],
  }
}

// Same rules as marketplacePhotos.resolve() on the server: a receipt replaces
// the image link, must match the seller's listing and a finished upload, and
// cannot be combined with a link.
function resolveMockPhoto(m, body, listingId) {
  if (body.imageUploadReceipt === undefined) {
    return body.imageUrl !== undefined ? { imageUrl: String(body.imageUrl || '').trim() || null } : {}
  }
  if (body.imageUrl) return { error: 'Choose either an uploaded photo or an image link.' }
  const receipt = m.receipts.get(body.imageUploadReceipt)
  if (!receipt || receipt.listingId !== (listingId || null)) return { error: 'This photo belongs to another seller or listing.' }
  if (!m.uploads.has(receipt.path)) return { error: 'The uploaded photo is missing or incomplete. Choose it again and retry.' }
  return { imageUrl: `${STORAGE_PUBLIC_BASE}/${receipt.path}` }
}

// Parking (#14): two garages with live counts, one without (sensor offline),
// plus the permit block the page renders. Mirrors buildSnapshot()'s output.
function sampleParkingGarage(overrides) {
  return {
    id: 'blackford',
    name: 'Blackford Garage',
    sourceName: 'Blackford Garage',
    code: 'XF',
    address: '725 W Michigan St',
    type: 'Permit only',
    stRule: 'All ST spaces',
    lat: 39.77511025,
    lng: -86.17058223,
    capacity: 1143,
    occupied: 168,
    available: 975,
    percentFull: 15,
    status: 'open',
    icon: 'icon-10P',
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    stale: false,
    ...overrides,
  }
}

export function sampleParkingSnapshot(overrides = {}) {
  return {
    ok: true,
    source: 'iu-parking-lotcount',
    sourceUrl: 'https://v2.aitapps.iu.edu/INPARK_LotCount_V1_Online/IN',
    fetchedAt: new Date().toISOString(),
    garages: [
      sampleParkingGarage(),
      sampleParkingGarage({
        id: 'gateway', name: 'Gateway Garage', sourceName: 'Gateway Garage', code: 'XL', address: '525 N Blackford St',
        type: 'Student permit and visitor', lat: 39.775222, lng: -86.16931,
        capacity: 1333, occupied: 955, available: 378, percentFull: 72, status: 'busy', icon: 'icon-70P',
      }),
      sampleParkingGarage({
        id: 'barnhill', name: 'Barnhill Garage', sourceName: 'Barnhill Garage', code: 'XH', address: '345 Barnhill Dr',
        type: 'Student permit only', lat: 39.772546, lng: -86.178061,
        capacity: 1324, occupied: null, available: null, percentFull: null, status: 'unknown', icon: 'icon-Full', updatedAt: null, stale: true,
      }),
    ],
    permits: {
      reviewedOn: '2026-09-03',
      permits: [
        { code: 'ST', name: 'ST commuter student permit', eligibility: 'Any student not living in campus housing.', valid: 'ST and NC surface spaces plus the student garages.', afterHours: 'EM surface spaces after 4 pm on weekdays and all weekend.' },
        { code: 'NCS', name: 'NCS north campus student permit', eligibility: 'Any student.', valid: 'NC surface spaces on Indiana Avenue.', afterHours: 'ST and EM surface spaces after 4 pm on weekdays and all weekend.' },
      ],
      links: [
        { label: 'Buy or manage a permit (IU Parking Portal)', href: 'https://parkingiu.t2hosted.com/Account/Portal' },
        { label: 'Permit types and rules', href: 'https://parking.indianapolis.iu.edu/parking/permits/index.html' },
      ],
      notes: ['Counts come from IU Parking garage sensors and can lag or drift.'],
    },
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
      // Parking status (#14). null === use the built-in sample snapshot.
      parking: null,
      // Club directory (#16): { clubs, degraded }. null === the built-in sample list.
      clubs: null,
      // Marketplace (#32) + listing photos (#171): see defaultMarketplace / seedMarketplace.
      marketplace: defaultMarketplace(),
      // Web Push (#9): see defaultPush / seedPush.
      push: defaultPush(),
      pushSeq: 0,
      // Live transit relay (server.mjs proxies TransLoc GetRoutes / GetStops /
      // GetMapVehiclePoints). Plain arrays like the upstream feed: Transit.tsx
      // stores them as-is and would throw on the generic `{ items: [] }`
      // fallback below.
      transit: { routes: [], stops: [], vehicles: [] },
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
      const { pathname, searchParams } = new URL(req.url())
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

      // Marketplace (#32) and listing photos (#171): shapes mirror mapListingRow
      // and the /api/marketplace/* routes in server.mjs, including the receipt
      // flow (authorize here, PUT to the mocked Storage below, receipt instead
      // of imageUrl on create / edit).
      if (pathname === '/api/marketplace/photos/authorize' && method === 'POST') {
        const m = state.marketplace
        if (m.photosUnavailable) {
          return json(route, 503, { error: { message: 'Photo storage settings need attention. Please try again later.', status: 503 } })
        }
        const b = bodyOf()
        if (b.contentType !== 'image/jpeg' || !Number.isInteger(b.byteSize) || b.byteSize < 4 || b.byteSize > 5 * 1024 * 1024) {
          return json(route, 400, { error: { message: 'Choose a JPEG photo no larger than 5 MB.', status: 400 } })
        }
        if (b.listingId && !m.listings.some((l) => l.id === b.listingId && l.isMine)) {
          return json(route, 404, { error: { message: 'Listing not found or not yours.', status: 404 } })
        }
        const n = ++m.photoSeq
        const path = `managed/${DEFAULT_USER.id}/${Date.now()}-photo-${n}.jpg`
        const receipt = `receipt-${n}`
        m.receipts.set(receipt, { path, byteSize: b.byteSize, listingId: b.listingId || null })
        return json(route, 201, {
          upload: { bucket: 'marketplace-images', path, token: `token-${n}`, receipt, expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
        })
      }
      if (pathname === '/api/marketplace' && method === 'GET') {
        const m = state.marketplace
        const category = (searchParams.get('category') || '').trim().toLowerCase()
        const q = (searchParams.get('q') || '').trim().toLowerCase()
        const page = Math.max(0, Number(searchParams.get('page')) || 0)
        const visible = m.listings.filter(
          (l) => l.status === 'active' && (!category || l.category === category) && (!q || l.title.toLowerCase().includes(q)),
        )
        const slice = visible.slice(page * 24, page * 24 + 24)
        return json(route, 200, { listings: slice, page, hasMore: slice.length === 24, canPost: Boolean(state.onboarding.hasPurdueLinked) })
      }
      if (pathname === '/api/marketplace/mine' && method === 'GET') {
        return json(route, 200, { listings: state.marketplace.listings.filter((l) => l.isMine) })
      }
      if (pathname === '/api/marketplace' && method === 'POST') {
        const m = state.marketplace
        const b = bodyOf()
        m.bodies.push({ method, body: b })
        const title = String(b.title || '').trim()
        if (!title) return json(route, 400, { error: { message: 'Title is required (max 120 characters)', status: 400 } })
        const photo = resolveMockPhoto(m, b, null)
        if (photo.error) return json(route, 400, { error: { message: photo.error, status: 400 } })
        const listing = {
          id: `listing-${++m.listingSeq}`,
          title,
          description: String(b.description || '').trim(),
          category: String(b.category || 'misc'),
          priceCents: b.priceCents == null ? null : Number(b.priceCents),
          imageUrl: photo.imageUrl ?? null,
          status: 'active',
          createdAt: new Date().toISOString(),
          isMine: true,
        }
        m.listings.unshift(listing)
        return json(route, 201, { listing })
      }
      const listingMatch = pathname.match(/^\/api\/marketplace\/([^/]+)(\/report)?$/)
      if (listingMatch && listingMatch[1] !== 'mine' && listingMatch[1] !== 'photos') {
        const m = state.marketplace
        const listing = m.listings.find((l) => l.id === listingMatch[1])
        if (listingMatch[2] && method === 'POST') return json(route, 200, { ok: true })
        if (!listing) return json(route, 404, { error: { message: 'Listing not found.', status: 404 } })
        if (method === 'GET') {
          const seller = listing.isMine
            ? { sellerName: DEFAULT_USER.name, sellerEmail: DEFAULT_USER.email }
            : { sellerName: 'Riley Boilermaker', sellerEmail: 'riley@purdue.edu' }
          return json(route, 200, { listing: { ...listing, ...seller } })
        }
        if (method === 'PATCH') {
          const b = bodyOf()
          m.bodies.push({ method, id: listing.id, body: b })
          if (!listing.isMine) return json(route, 404, { error: { message: 'Listing not found or not yours.', status: 404 } })
          const photo = resolveMockPhoto(m, b, listing.id)
          if (photo.error) return json(route, 400, { error: { message: photo.error, status: 400 } })
          for (const key of ['title', 'description', 'category', 'status']) {
            if (b[key] !== undefined) listing[key] = String(b[key])
          }
          if (b.priceCents !== undefined) listing.priceCents = b.priceCents == null ? null : Number(b.priceCents)
          if (photo.imageUrl !== undefined) listing.imageUrl = photo.imageUrl
          return json(route, 200, { listing: { ...listing } })
        }
        if (method === 'DELETE') {
          m.listings = m.listings.filter((l) => l.id !== listing.id)
          return route.fulfill({ status: 204, body: '' })
        }
      }

      // Club directory (#16): the payload shape mirrors searchClubDirectory()
      // in src/boilerlinkClubs.mjs, filters included.
      if (pathname === '/api/clubs' && method === 'GET') {
        const seed = state.clubs || {}
        if (seed.degraded) return json(route, 200, degradedSampleClubs(searchParams))
        return json(route, 200, searchSampleClubs(seed.clubs || sampleClubs(), searchParams))
      }

      // Parking status (#14): the payload shape mirrors src/parkingStatus.mjs.
      if (pathname === '/api/parking/garages') {
        return json(route, 200, state.parking ?? sampleParkingSnapshot())
      }

      // Web Push (#9): shapes mirror the /api/push/* routes in server.mjs.
      if (pathname === '/api/push/config') {
        return json(route, 200, { ...state.push.config })
      }
      if (pathname === '/api/push/settings' && method === 'GET') {
        if (state.push.notConfigured) {
          return json(route, 503, {
            error: {
              code: 'push_not_configured',
              message: 'Push notifications are not set up on this server yet: the push tables are missing.',
              status: 503,
            },
          })
        }
        return json(route, 200, {
          enabled: state.push.config.enabled,
          settings: { ...state.push.settings },
          subscriptions: state.push.subscriptions.map(({ id, createdAt, userAgent, lastUsedAt }) => ({
            id,
            createdAt,
            userAgent,
            lastUsedAt,
          })),
        })
      }
      if (pathname === '/api/push/settings' && method === 'PUT') {
        const b = bodyOf()
        if (b.leadMinutes !== undefined) {
          const lead = Number(b.leadMinutes)
          if (!Number.isInteger(lead) || lead < 5 || lead > 10080) {
            return json(route, 400, {
              error: { code: 'invalid_lead_minutes', message: 'leadMinutes must be a whole number between 5 and 10080.', status: 400 },
            })
          }
          state.push.settings.leadMinutes = lead
        }
        if (b.deadlineReminders !== undefined) state.push.settings.deadlineReminders = Boolean(b.deadlineReminders)
        return json(route, 200, { settings: { ...state.push.settings } })
      }
      if (pathname === '/api/push/subscriptions' && method === 'POST') {
        const { subscription, userAgent } = bodyOf()
        const endpoint = subscription && subscription.endpoint
        if (!endpoint) {
          return json(route, 400, {
            error: { code: 'invalid_subscription', message: 'A push subscription with an endpoint is required.', status: 400 },
          })
        }
        // Upsert by endpoint, like the real table's unique index.
        let existing = state.push.subscriptions.find((s) => s.endpoint === endpoint)
        if (!existing) {
          existing = {
            id: `push-${++state.pushSeq}`,
            endpoint,
            createdAt: new Date().toISOString(),
            userAgent: userAgent || null,
            lastUsedAt: null,
          }
          state.push.subscriptions.push(existing)
        } else if (userAgent) {
          existing.userAgent = userAgent
        }
        return json(route, 201, { subscription: { id: existing.id, createdAt: existing.createdAt } })
      }
      if (pathname === '/api/push/subscriptions' && method === 'DELETE') {
        const { endpoint } = bodyOf()
        const before = state.push.subscriptions.length
        state.push.subscriptions = state.push.subscriptions.filter((s) => s.endpoint !== endpoint)
        return json(route, 200, { removed: state.push.subscriptions.length < before })
      }
      if (pathname === '/api/push/test' && method === 'POST') {
        return json(route, 200, { sent: state.push.subscriptions.length, failed: 0, removed: 0 })
      }

      // Transit (issue #162): arrays seeded via seedTransit, empty by default.
      if (pathname === '/api/transit/routes') {
        return json(route, 200, state.transit.routes)
      }
      if (pathname === '/api/transit/stops') {
        return json(route, 200, state.transit.stops)
      }
      if (pathname === '/api/transit/vehicles') {
        return json(route, 200, state.transit.vehicles)
      }

      // Unmapped endpoints: a benign empty success so pages that fan out extra
      // reads (sources, profile, dining) render instead of erroring.
      return json(route, 200, { items: [], ok: true })
    })

    // Supabase Storage (#171): the browser PUTs a listing photo straight to the
    // signed upload URL and later reads it back from the public bucket URL.
    // The PUT body is kept (the JPEG is cut out of it whether the client sent
    // raw bytes or a multipart form) so the public GET serves the real photo
    // and the card's <img> renders exactly what was uploaded.
    await context.route('**/storage/v1/object/upload/sign/**', (route) => {
      const m = state.marketplace
      const request = route.request()
      if (request.method() !== 'PUT') return route.fulfill({ status: 405, body: '' })
      if (m.failNextUpload) {
        m.failNextUpload = false
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ statusCode: '500', error: 'InternalError', message: 'mock storage failure' }),
        })
      }
      const path = decodeURIComponent(new URL(request.url()).pathname.split('/marketplace-images/')[1] || '')
      const raw = request.postDataBuffer() || Buffer.alloc(0)
      const start = raw.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
      const end = raw.lastIndexOf(Buffer.from([0xff, 0xd9]))
      m.uploads.set(path, start >= 0 && end > start ? raw.subarray(start, end + 2) : raw)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Key: `marketplace-images/${path}` }) })
    })
    await context.route('**/storage/v1/object/public/marketplace-images/**', (route) => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname.split('/marketplace-images/')[1] || '')
      const bytes = state.marketplace.uploads.get(path)
      if (!bytes) return route.fulfill({ status: 404, body: 'not found' })
      return route.fulfill({ status: 200, contentType: 'image/jpeg', body: bytes })
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
      seedParking(snapshot) {
        state.parking = snapshot
      },
      seedClubs({ clubs = null, degraded = false } = {}) {
        state.clubs = { clubs, degraded }
      },
      seedMarketplace({ listings, photosUnavailable } = {}) {
        if (listings) state.marketplace.listings = listings
        if (photosUnavailable !== undefined) state.marketplace.photosUnavailable = photosUnavailable
      },
      failNextPhotoUpload() {
        state.marketplace.failNextUpload = true
      },
      seedPush(overrides = {}) {
        state.push = defaultPush(overrides)
        state.pushSeq = state.push.subscriptions.length
      },
      seedTransit({ routes = [], stops = [], vehicles = [] } = {}) {
        state.transit = { routes, stops, vehicles }
      },
    }

    await use(controller)
  },
})

export { expect }
