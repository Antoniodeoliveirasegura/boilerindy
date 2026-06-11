import 'dotenv/config'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'
import session from 'express-session'
import ical from 'node-ical'
import { createClient } from '@supabase/supabase-js'
import { cancelCalendarCapture, getCalendarCaptureJob, startCalendarCapture } from './purdueCalendarAutomation.mjs'
import { getDiningSnapshot } from './nutrisliceDining.mjs'
import {
  assertBoardPostTextAllowed,
  boardTextFailsPolicy,
  BOARD_PROFANITY_USER_MESSAGE,
} from './boardProfanity.mjs'
import { createRateLimiter } from './rateLimiter.mjs'
import { planSync, classifyFetchError, detectTimezoneFromFeed, expandRecurringEvents } from './scheduleSync.mjs'
import { createCalendarItemStore } from './calendarItemStore.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TERM_ORDER = { spring: 1, summer: 2, fall: 3 }

const app = express()
const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '127.0.0.1'
const publicBaseUrl = (process.env.BACKEND_PUBLIC_URL || process.env.BETTER_AUTH_URL || `http://${host}:${port}`).replace(/\/$/, '')
const clientAppUrl = (process.env.CLIENT_APP_URL || 'http://localhost:5173').replace(/\/$/, '')
const purdueAuthMode = (process.env.PURDUE_AUTH_MODE || 'mock').toLowerCase()
const defaultNextPath = '/setup'

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables')
  console.error('Please set these in your .env file:')
  console.error('  SUPABASE_URL=https://your-project.supabase.co')
  console.error('  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(
  session({
    name: 'pih.sid',
    secret: process.env.SESSION_SECRET || process.env.BETTER_AUTH_SECRET || 'dev-session-secret',
    resave: false,
    saveUninitialized: false,
    // Refresh the cookie on every response so active users are never logged
    // out mid-task; the client warns shortly before idle expiry (issue #23)
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  }),
)
app.use(express.static(__dirname))

// ── Abuse protection (issue #22) ────────────────────────────────────────────
// Per-user buckets when signed in, per-IP otherwise. Tunable via
// RATE_LIMIT_* env vars; full endpoint coverage in docs/RATE_LIMITS.md.
const signInRateLimit = createRateLimiter({
  name: 'sign-in',
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyBy: 'ip',
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
})
const accountCreateRateLimit = createRateLimiter({
  name: 'account-create',
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyBy: 'ip',
  message: 'Too many account requests from this network. Please try again in an hour.',
})
const sessionSyncRateLimit = createRateLimiter({
  name: 'session-sync',
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyBy: 'ip',
  message: 'Too many session requests. Please slow down and try again shortly.',
})
const boardWriteRateLimit = createRateLimiter({
  name: 'board-write',
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'You are posting too quickly. Take a short break and try again.',
})
const sourceSyncRateLimit = createRateLimiter({
  name: 'source-sync',
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many sync requests. Please wait a few minutes before syncing again.',
})

function nowIso() {
  return new Date().toISOString()
}

function startOfToday() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

function makeId() {
  return crypto.randomUUID()
}

function sanitizeNext(next) {
  if (!next || typeof next !== 'string' || !next.startsWith('/')) return defaultNextPath
  return next
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function deriveDisplayName(email, providedName = '') {
  if (providedName && providedName.trim()) return providedName.trim()
  if (!email) return 'Student'
  const local = email.split('@')[0] || 'student'
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHash] = String(storedHash || '').split(':')
  if (!salt || !expectedHash) return false
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))
}

async function getUserById(userId) {
  if (!userId) return null
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single()
  if (error || !data) return null
  return data
}

async function getUserByEmail(email) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', normalizeEmail(email))
    .single()
  if (error || !data) return null
  return data
}

async function createLocalUser({ email, password, displayName }) {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Please enter a valid email address.')
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters.')
  }
  
  const existing = await getUserByEmail(normalizedEmail)
  if (existing) {
    throw new Error('An account with that email already exists.')
  }

  const timestamp = nowIso()
  const id = makeId()
  
  const { data, error } = await supabase
    .from('users')
    .insert({
      id,
      email: normalizedEmail,
      password_hash: hashPassword(password),
      display_name: deriveDisplayName(normalizedEmail, displayName),
      auth_provider: 'local',
      created_at: timestamp,
      updated_at: timestamp
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

async function authenticateLocalUser({ email, password }) {
  const user = await getUserByEmail(email)
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new Error('Invalid email or password.')
  }
  return user
}

async function updateLocalUserProfile(userId, { email, displayName, currentPassword, newPassword }) {
  const user = await getUserById(userId)
  if (!user) throw new Error('User not found.')

  const normalizedEmail = normalizeEmail(email || user.email)
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Please enter a valid email address.')
  }

  const existingUser = await getUserByEmail(normalizedEmail)
  if (existingUser && existingUser.id !== userId) {
    throw new Error('That email address is already in use.')
  }

  let passwordHash = user.password_hash
  const wantsPasswordChange = Boolean((currentPassword && currentPassword.trim()) || (newPassword && newPassword.trim()))
  if (wantsPasswordChange) {
    if (!verifyPassword(currentPassword || '', user.password_hash)) {
      throw new Error('Current password is incorrect.')
    }
    if (!newPassword || newPassword.length < 8) {
      throw new Error('New password must be at least 8 characters.')
    }
    passwordHash = hashPassword(newPassword)
  }

  const nextDisplayName = deriveDisplayName(normalizedEmail, displayName || user.display_name)
  const timestamp = nowIso()
  
  const { data, error } = await supabase
    .from('users')
    .update({
      email: normalizedEmail,
      display_name: nextDisplayName,
      password_hash: passwordHash,
      updated_at: timestamp
    })
    .eq('id', userId)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

function getAcademicTerm(dateValue) {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return null
  const month = date.getMonth()
  const year = date.getFullYear()
  let season = 'fall'
  if (month <= 4) season = 'spring'
  else if (month <= 6) season = 'summer'
  return {
    key: `${year}-${season}`,
    year,
    season,
    label: `${season.charAt(0).toUpperCase() + season.slice(1)} ${year}`,
  }
}

function parseTermKey(termKey) {
  const [yearPart, season] = String(termKey || '').split('-')
  const year = Number(yearPart)
  if (!year || !TERM_ORDER[season]) return null
  return { key: `${year}-${season}`, year, season, label: `${season.charAt(0).toUpperCase() + season.slice(1)} ${year}` }
}

function compareTermKeys(a, b) {
  const left = parseTermKey(a)
  const right = parseTermKey(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  if (left.year !== right.year) return left.year - right.year
  return TERM_ORDER[left.season] - TERM_ORDER[right.season]
}

function getPreferredClassTerm(items) {
  if (!items.length) return null

  const groups = new Map()
  for (const item of items) {
    const term = getAcademicTerm(item.start_time)
    if (!term) continue
    const start = new Date(item.start_time)
    const end = new Date(item.end_time || item.start_time)
    const current = groups.get(term.key) || {
      key: term.key,
      label: term.label,
      minStart: start,
      maxEnd: end,
    }
    if (start < current.minStart) current.minStart = start
    if (end > current.maxEnd) current.maxEnd = end
    groups.set(term.key, current)
  }

  if (!groups.size) return null

  const today = startOfToday()
  const currentTerm = getAcademicTerm(today)
  const currentGroup = currentTerm ? groups.get(currentTerm.key) : null
  if (currentGroup && currentGroup.maxEnd >= today) {
    return parseTermKey(currentGroup.key)
  }

  const upcomingGroups = [...groups.values()]
    .filter((group) => group.maxEnd >= today)
    .sort((a, b) => a.minStart - b.minStart || compareTermKeys(a.key, b.key))
  if (upcomingGroups.length) {
    return parseTermKey(upcomingGroups[0].key)
  }

  const latestGroup = [...groups.values()].sort((a, b) => compareTermKeys(b.key, a.key) || b.maxEnd - a.maxEnd)[0]
  return latestGroup ? parseTermKey(latestGroup.key) : null
}

function orderClassItemsForDisplay(items) {
  const now = new Date()
  const upcoming = items
    .filter((item) => new Date(item.end_time || item.start_time) >= now)
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))

  if (upcoming.length) return upcoming

  return [...items].sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
}

async function getUserSummary(userId) {
  const user = await getUserById(userId)
  
  const { count: linkedSourceCount } = await supabase
    .from('linked_sources')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)

  const { count: classCount } = await supabase
    .from('calendar_items')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('category', 'class')

  const hasPurdueLinked = Boolean(user?.purdue_email)
  return {
    linkedSourceCount: linkedSourceCount || 0,
    classCount: classCount || 0,
    hasPurdueLinked,
    needsPurdueConnection: !hasPurdueLinked,
    needsScheduleSource: hasPurdueLinked && (linkedSourceCount || 0) === 0,
  }
}

async function getCurrentUser(req) {
  return await getUserById(req.session.userId)
}

async function buildSessionPayload(user, req) {
  if (!user) return null
  const summary = await getUserSummary(user.id)
  // Cookie expiry lets the client warn before the session lapses (issue #23)
  const cookieExpires = req?.session?.cookie?.expires
  return {
    expiresAt: cookieExpires ? new Date(cookieExpires).toISOString() : null,
    user: {
      id: user.id,
      email: user.email,
      name: user.display_name,
      authProvider: user.auth_provider,
      purdueEmail: user.purdue_email,
      purdueUsername: user.purdue_username,
      hasPurdueLinked: Boolean(user.purdue_email),
    },
    onboarding: summary,
  }
}

async function requireAuth(req, res, next) {
  const user = await getCurrentUser(req)
  if (!user) {
    return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
  }
  req.currentUser = user
  next()
}

function requirePurdueLinked(req, res, next) {
  if (!req.currentUser?.purdue_email) {
    return res.status(400).json({
      error: {
        message: 'Link your Purdue account before connecting Purdue schedule data.',
        status: 400,
      },
    })
  }
  next()
}

async function listSourcesForUser(userId) {
  const { data, error } = await supabase
    .from('linked_sources')
    .select('id, source_type, label, source_url, status, last_synced_at, last_error, created_at, updated_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) return []
  return data.map(row => ({
    id: row.id,
    sourceType: row.source_type,
    label: row.label,
    sourceUrl: row.source_url,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

async function getSourceForUser(sourceId, userId) {
  const { data, error } = await supabase
    .from('linked_sources')
    .select('*')
    .eq('id', sourceId)
    .eq('user_id', userId)
    .single()

  if (error || !data) return null
  return data
}

function validateSourceUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http and https URLs are supported.')
    }
    return parsed.toString()
  } catch {
    throw new Error('Please enter a valid iCalendar URL.')
  }
}

// ── Schedule sync (imperative shell) ─────────────────────────────────────────
// The pure plan lives in scheduleSync.mjs; this shell owns the fetch, the
// database writes (via calendarItemStore), and item identity stamping.
const calendarItemStore = createCalendarItemStore(supabase)

async function runScheduleSync(source) {
  const syncedAt = nowIso()
  const sourceId = source.id

  let eventsByKey
  try {
    eventsByKey = await ical.async.fromURL(source.source_url)
  } catch (fetchError) {
    const classified = classifyFetchError(fetchError)
    console.error('[runScheduleSync] Fetch failed for source=' + sourceId + ':', fetchError?.message || fetchError)
    await calendarItemStore.setStatus(sourceId, classified.status, classified.message)
    throw new Error(classified.message)
  }

  const plan = planSync(eventsByKey, source)

  // Empty feed parsed cleanly: leave any existing items untouched (prior behaviour).
  if (plan.meta.rawCount === 0) {
    await calendarItemStore.setStatus(sourceId, plan.sourceStatus, plan.statusMessage, { markSynced: true })
    return { syncedAt, itemCount: 0, warning: plan.meta.warning }
  }

  try {
    await calendarItemStore.replaceItems(sourceId, plan.itemsToInsert)
  } catch (insertError) {
    await calendarItemStore.setStatus(sourceId, 'error', 'Failed to save events: ' + insertError.message)
    throw new Error('Failed to save calendar events: ' + insertError.message)
  }

  await calendarItemStore.setStatus(sourceId, plan.sourceStatus, plan.statusMessage, { markSynced: true })

  console.log('[runScheduleSync] source=' + sourceId + ': ' + plan.meta.itemCount + ' items saved (' + plan.meta.skippedCount + ' skipped, ' + plan.meta.duplicateCount + ' duplicates removed)')

  return {
    syncedAt,
    itemCount: plan.meta.itemCount,
    skippedCount: plan.meta.skippedCount,
    timezone: plan.meta.timezone,
  }
}

async function createScheduleSource(userId, { icsUrl, label, sourceType = 'purdue_schedule_ical' }) {
  const sourceUrl = validateSourceUrl(icsUrl)
  const timestamp = nowIso()
  const id = makeId()

  const { data, error } = await supabase
    .from('linked_sources')
    .insert({
      id,
      user_id: userId,
      source_type: sourceType,
      label: (label || 'Schedule').trim() || 'Schedule',
      source_url: sourceUrl,
      status: 'pending',
      created_at: timestamp,
      updated_at: timestamp
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

async function listCalendarItems(userId, { category, categories, limit = 100, order = 'asc', from = null } = {}) {
  let query = supabase
    .from('calendar_items')
    .select('id, source_id, title, description, start_time, end_time, location, category, external_uid, source_type')
    .eq('user_id', userId)

  if (category) {
    query = query.eq('category', category)
  } else if (categories && categories.length > 0) {
    query = query.in('category', categories)
  }

  if (from) {
    query = query.gte('start_time', from)
  }

  query = query.order('start_time', { ascending: order === 'asc' }).limit(Number(limit) || 100)

  const { data, error } = await query

  if (error) return []
  return data.map(row => ({
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    description: row.description,
    startTime: row.start_time,
    endTime: row.end_time,
    location: row.location,
    category: row.category,
    externalUid: row.external_uid,
    sourceType: row.source_type
  }))
}

async function getClassItemsForUser(userId, { limit = 20, term = 'auto', mode = 'display' } = {}) {
  const allItems = await listCalendarItems(userId, { category: 'class', limit: 5000, order: 'asc' })
  if (!allItems.length) {
    return {
      items: [],
      meta: {
        selectedTermKey: null,
        selectedTermLabel: null,
        totalInTerm: 0,
      },
    }
  }

  // Convert camelCase to snake_case for term processing
  const itemsForTermProcessing = allItems.map(item => ({
    ...item,
    start_time: item.startTime,
    end_time: item.endTime
  }))

  const preferredTerm = term === 'all' ? null : (term && term !== 'auto' ? parseTermKey(term) : getPreferredClassTerm(itemsForTermProcessing))
  const termItems = preferredTerm
    ? allItems.filter((item) => getAcademicTerm(item.startTime)?.key === preferredTerm.key)
    : allItems

  const orderedItems = mode === 'display'
    ? orderClassItemsForDisplay(termItems.map(item => ({ ...item, start_time: item.startTime, end_time: item.endTime })))
        .map(item => ({ ...item, startTime: item.start_time, endTime: item.end_time }))
    : [...termItems].sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

  return {
    items: orderedItems.slice(0, Number(limit) || 20),
    meta: {
      selectedTermKey: preferredTerm?.key || null,
      selectedTermLabel: preferredTerm?.label || null,
      totalInTerm: termItems.length,
    },
  }
}

async function linkPurdueIdentity(userId, { email }) {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !normalizedEmail.endsWith('@purdue.edu')) {
    throw new Error('Please use a valid @purdue.edu account.')
  }

  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('purdue_email', normalizedEmail)
    .neq('id', userId)
    .single()

  if (existing) {
    throw new Error('That Purdue account is already linked to another user.')
  }

  const username = normalizedEmail.split('@')[0]
  const timestamp = nowIso()

  const { data, error } = await supabase
    .from('users')
    .update({
      purdue_email: normalizedEmail,
      purdue_username: username,
      purdue_linked_at: timestamp,
      updated_at: timestamp
    })
    .eq('id', userId)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

async function validateCasTicket(ticket, nextPath) {
  const loginUrl = process.env.PURDUE_CAS_LOGIN_URL
  const validateUrl = process.env.PURDUE_CAS_VALIDATE_URL
  if (!loginUrl || !validateUrl) {
    throw new Error('CAS mode requires PURDUE_CAS_LOGIN_URL and PURDUE_CAS_VALIDATE_URL.')
  }

  const serviceUrl = `${publicBaseUrl}/auth/purdue/callback?next=${encodeURIComponent(nextPath)}`
  const response = await fetch(`${validateUrl}?service=${encodeURIComponent(serviceUrl)}&ticket=${encodeURIComponent(ticket)}`)
  const xml = await response.text()
  const userMatch = xml.match(/<cas:user>([^<]+)<\/cas:user>/i)
  if (!userMatch) throw new Error('CAS ticket validation failed.')
  const emailMatch = xml.match(/<cas:(?:mail|email)>([^<]+)<\/cas:(?:mail|email)>/i)
  const username = userMatch[1].trim()
  const email = emailMatch?.[1]?.trim() || `${username}@purdue.edu`
  return { email }
}

function renderMockPurdueLinkPage(nextPath, message = '', currentEmail = '') {
  const defaultEmail = currentEmail || process.env.DEV_PURDUE_EMAIL || 'student@purdue.edu'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link Purdue Account</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#f5f4f1;color:#1a1918;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
    .card{width:min(100%,420px);background:#fff;border:1px solid rgba(26,25,24,.08);border-radius:16px;padding:24px;box-shadow:0 8px 32px rgba(26,25,24,.08)}
    .badge{display:inline-block;background:#CFB991;color:#3E2200;font-size:10px;font-weight:700;padding:4px 10px;border-radius:999px;letter-spacing:.08em;text-transform:uppercase}
    h1{font-size:24px;margin:16px 0 8px}
    p{font-size:14px;line-height:1.6;color:#4A4844}
    label{display:block;font-size:12px;font-weight:600;margin:16px 0 6px}
    input{width:100%;box-sizing:border-box;border:1px solid rgba(26,25,24,.14);border-radius:10px;padding:12px 14px;font:inherit}
    button{margin-top:20px;width:100%;border:0;border-radius:10px;background:#CFB991;color:#3E2200;padding:12px 14px;font:inherit;font-weight:700;cursor:pointer}
    .msg{margin-top:12px;color:#b42318;font-size:13px}
  </style>
</head>
<body>
  <form class="card" method="post" action="/auth/purdue/dev/link">
    <span class="badge">Mock Purdue Link</span>
    <h1>Link your Purdue account</h1>
    <p>This development screen stands in for Purdue CAS account linking until official CAS service registration is available.</p>
    <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
    <label for="email">Purdue email</label>
    <input id="email" name="email" type="email" value="${escapeHtml(defaultEmail)}" required />
    <button type="submit">Link Purdue account</button>
    ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}
  </form>
</body>
</html>`
}

app.get('/api/auth-config', (_req, res) => {
  res.json({
    authProvider: 'local',
    purdueAuthMode,
    supportsPurdueLink: true,
    supportedSources: ['purdue_schedule_ical'],
  })
})

app.get('/api/session', async (req, res) => {
  const user = await getCurrentUser(req)
  const sessionPayload = await buildSessionPayload(user, req)
  res.json({ authenticated: Boolean(sessionPayload), session: sessionPayload })
})

app.post('/api/auth/register-supabase', accountCreateRateLimit, async (req, res) => {
  try {
    const emailRaw = req.body.email
    const password = req.body.password
    const displayName = req.body.name ?? req.body.displayName ?? ''
    const rememberMe = req.body.rememberMe === true
    const cookieMaxAge = rememberMe ? 1000 * 60 * 60 * 24 * 30 : undefined
    const normalizedEmail = normalizeEmail(emailRaw)
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      return res.status(400).json({ error: { message: 'Please enter a valid email address.', status: 400 } })
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: { message: 'Password must be at least 8 characters.', status: 400 } })
    }

    const existingRow = await getUserByEmail(normalizedEmail)
    if (existingRow) {
      return res.status(400).json({ error: { message: 'An account with that email already exists.', status: 400 } })
    }

    const { data: created, error: authError } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: String(displayName).trim() || deriveDisplayName(normalizedEmail, ''),
      },
    })

    if (authError) {
      const raw = authError.message || 'Could not create account.'
      if (
        /already\s+registered|already\s+exists|duplicate/i.test(raw) ||
        authError.code === 'email_exists'
      ) {
        return res.status(400).json({ error: { message: 'An account with that email already exists.', status: 400 } })
      }
      return res.status(400).json({ error: { message: raw, status: 400 } })
    }

    const authUser = created.user
    const timestamp = nowIso()
    const { data: row, error: insertError } = await supabase
      .from('users')
      .insert({
        id: authUser.id,
        email: normalizedEmail,
        password_hash: hashPassword(password),
        display_name: deriveDisplayName(normalizedEmail, displayName),
        auth_provider: 'email',
        created_at: timestamp,
        updated_at: timestamp,
      })
      .select()
      .single()

    if (insertError) {
      console.error('register-supabase: public.users insert failed:', insertError)
      return res.status(500).json({
        error: { message: insertError.message || 'Could not create your profile.', status: 500 },
      })
    }

    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
      }
      req.session.cookie.maxAge = cookieMaxAge
      req.session.userId = row.id
      req.session.save(async () => {
        res.status(201).json({ session: await buildSessionPayload(row, req) })
      })
    })
  } catch (error) {
    res.status(500).json({ error: { message: error.message || 'Could not create account.', status: 500 } })
  }
})

app.post('/api/auth/sign-up', accountCreateRateLimit, async (req, res) => {
  try {
    const user = await createLocalUser({
      email: req.body.email,
      password: req.body.password,
      displayName: req.body.name,
    })
    req.session.regenerate(async (err) => {
      if (err) {
        return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
      }
      req.session.userId = user.id
      req.session.save(async () => {
        res.status(201).json({ session: await buildSessionPayload(user, req) })
      })
    })
  } catch (error) {
    res.status(400).json({ error: { message: error.message || 'Could not create account.', status: 400 } })
  }
})

async function verifySupabasePassword(email, password) {
  const gotrue = `${supabaseUrl}/auth/v1/token?grant_type=password`
  const anonKey = process.env.SUPABASE_ANON_KEY || supabaseServiceKey
  const resp = await fetch(gotrue, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
    },
    body: JSON.stringify({ email, password }),
  })
  if (!resp.ok) return null
  const data = await resp.json()
  return data?.user ?? null
}

async function ensureUserRowForSupabaseAuth(supabaseUser, fallbackEmail) {
  const normalizedEmail = normalizeEmail(supabaseUser?.email || fallbackEmail)
  if (!normalizedEmail) return null

  let user = await getUserByEmail(normalizedEmail)
  if (user) {
    const { data, error } = await supabase
      .from('users')
      .update({
        display_name:
          supabaseUser?.user_metadata?.full_name ||
          supabaseUser?.user_metadata?.name ||
          user.display_name ||
          deriveDisplayName(normalizedEmail, ''),
        auth_provider: user.auth_provider || 'email',
        updated_at: nowIso(),
      })
      .eq('id', user.id)
      .select()
      .single()

    return error ? user : data
  }

  const timestamp = nowIso()
  const { data, error } = await supabase
    .from('users')
    .insert({
      id: supabaseUser?.id || makeId(),
      email: normalizedEmail,
      password_hash: '',
      display_name:
        supabaseUser?.user_metadata?.full_name ||
        supabaseUser?.user_metadata?.name ||
        deriveDisplayName(normalizedEmail, ''),
      auth_provider: 'email',
      avatar_url: supabaseUser?.user_metadata?.avatar_url || null,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .select()
    .single()

  if (error) {
    const existing = await getUserByEmail(normalizedEmail)
    if (existing) return existing
    throw new Error(error.message || 'Could not create your profile.')
  }

  return data
}

app.post('/api/auth/sign-in', signInRateLimit, async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email)
    const password = req.body.password
    const rememberMe = req.body.rememberMe === true
    const cookieMaxAge = rememberMe ? 1000 * 60 * 60 * 24 * 30 : undefined

    let user = await getUserByEmail(normalizedEmail)

    // Always allow Supabase Auth to be the source of truth if the local profile row/hash is missing or stale.
    let supabaseUser = null
    const hasLocalHash = user?.password_hash && user.password_hash.includes(':')
    const localPasswordMatches = hasLocalHash ? verifyPassword(password, user.password_hash) : false

    if (!localPasswordMatches) {
      supabaseUser = await verifySupabasePassword(normalizedEmail, password)
      if (!supabaseUser) {
        return res.status(401).json({ error: { message: 'Invalid email or password.', status: 401 } })
      }

      user = await ensureUserRowForSupabaseAuth(supabaseUser, normalizedEmail)

      await supabase
        .from('users')
        .update({ password_hash: hashPassword(password), updated_at: nowIso() })
        .eq('id', user.id)
    }

    if (!user) {
      return res.status(401).json({ error: { message: 'Invalid email or password.', status: 401 } })
    }

    req.session.regenerate(async (err) => {
      if (err) {
        return res.status(500).json({ error: { message: 'Could not create a session.', status: 500 } })
      }
      req.session.cookie.maxAge = cookieMaxAge
      req.session.userId = user.id
      req.session.save(async () => {
        res.json({ session: await buildSessionPayload(user, req) })
      })
    })
  } catch (error) {
    res.status(401).json({ error: { message: error.message || 'Could not sign in.', status: 401 } })
  }
})

app.post('/api/sign-out', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('pih.sid')
    res.json({ ok: true })
  })
})

app.post('/api/auth/supabase-sync', sessionSyncRateLimit, async (req, res) => {
  try {
    const { supabaseUserId, email, name, avatarUrl, provider, accessToken } = req.body
    
    if (!supabaseUserId || !email) {
      return res.status(400).json({ error: { message: 'Missing required fields', status: 400 } })
    }

    const normalizedEmail = normalizeEmail(email)
    
    let user = await getUserByEmail(normalizedEmail)
    
    if (!user) {
      const timestamp = nowIso()
      const { data, error } = await supabase
        .from('users')
        .insert({
          id: supabaseUserId,
          email: normalizedEmail,
          password_hash: '',
          display_name: deriveDisplayName(normalizedEmail, name),
          auth_provider: provider || 'supabase',
          avatar_url: avatarUrl || null,
          created_at: timestamp,
          updated_at: timestamp
        })
        .select()
        .single()

      if (error) {
        if (error.code === '23505') {
          user = await getUserByEmail(normalizedEmail)
        } else {
          throw new Error(error.message)
        }
      } else {
        user = data
      }
    } else {
      const { data, error } = await supabase
        .from('users')
        .update({
          display_name: name || user.display_name,
          avatar_url: avatarUrl || user.avatar_url,
          auth_provider: user.auth_provider === 'local' ? user.auth_provider : (provider || user.auth_provider),
          updated_at: nowIso()
        })
        .eq('id', user.id)
        .select()
        .single()

      if (error) {
        console.error('Failed to update user:', error)
      } else {
        user = data
      }
    }

    if (!user) {
      return res.status(500).json({ error: { message: 'Could not sync user profile.', status: 500 } })
    }

    req.session.userId = user.id

    const session = await buildSessionPayload(user, req)
    res.json({ session })
  } catch (error) {
    console.error('Supabase sync error:', error)
    res.status(500).json({ error: { message: error.message || 'Could not sync user.', status: 500 } })
  }
})

app.get('/auth/purdue/connect', requireAuth, (req, res) => {
  const nextPath = sanitizeNext(req.query.next)
  if (purdueAuthMode === 'cas') {
    const loginUrl = process.env.PURDUE_CAS_LOGIN_URL
    const validateUrl = process.env.PURDUE_CAS_VALIDATE_URL
    if (!loginUrl || !validateUrl) {
      return res.redirect(`${clientAppUrl}/settings?error=cas-config`)
    }
    const serviceUrl = `${publicBaseUrl}/auth/purdue/callback?next=${encodeURIComponent(nextPath)}`
    return res.redirect(`${loginUrl}?service=${encodeURIComponent(serviceUrl)}`)
  }

  res.type('html').send(renderMockPurdueLinkPage(nextPath, '', req.currentUser.purdue_email))
})

app.post('/auth/purdue/dev/link', requireAuth, async (req, res) => {
  const nextPath = sanitizeNext(req.body.next)
  if (purdueAuthMode === 'cas') {
    return res.status(404).send('Mock Purdue linking is disabled while CAS mode is active.')
  }
  try {
    await linkPurdueIdentity(req.currentUser.id, {
      email: req.body.email,
    })
    res.redirect(`${clientAppUrl}${nextPath}`)
  } catch (error) {
    res.type('html').send(renderMockPurdueLinkPage(nextPath, error.message || 'Could not link Purdue account.', req.body.email))
  }
})

app.post('/api/purdue/mock-link', requireAuth, async (req, res) => {
  if (purdueAuthMode === 'cas') {
    return res.status(400).json({ error: { message: 'Mock Purdue linking is disabled while CAS mode is active.', status: 400 } })
  }
  try {
    await linkPurdueIdentity(req.currentUser.id, { email: req.body.email })
    const payload = await buildSessionPayload(await getUserById(req.currentUser.id), req)
    res.json({ ok: true, session: payload })
  } catch (error) {
    res.status(400).json({ error: { message: error.message || 'Could not link Purdue account.', status: 400 } })
  }
})

app.get('/auth/purdue/callback', requireAuth, async (req, res) => {
  const nextPath = sanitizeNext(req.query.next)
  const ticket = req.query.ticket
  if (!ticket) {
    return res.redirect(`${clientAppUrl}/settings?error=missing-ticket`)
  }
  try {
    const identity = await validateCasTicket(String(ticket), nextPath)
    await linkPurdueIdentity(req.currentUser.id, identity)
    res.redirect(`${clientAppUrl}${nextPath}`)
  } catch (error) {
    console.error(error)
    res.redirect(`${clientAppUrl}/settings?error=cas-validation`)
  }
})

app.get('/api/me/profile', requireAuth, async (req, res) => {
  const payload = await buildSessionPayload(req.currentUser, req)
  res.json({ user: payload.user })
})

app.patch('/api/me/profile', requireAuth, async (req, res) => {
  try {
    const user = await updateLocalUserProfile(req.currentUser.id, {
      email: req.body.email,
      displayName: req.body.name,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
    })
    const payload = await buildSessionPayload(user, req)
    res.json({ user: payload.user })
  } catch (error) {
    res.status(400).json({ error: { message: error.message || 'Could not update profile.', status: 400 } })
  }
})

app.get('/api/me/sources', requireAuth, async (req, res) => {
  res.json({ sources: await listSourcesForUser(req.currentUser.id) })
})

// Debug endpoint to diagnose calendar import issues
app.get('/api/debug/source/:sourceId', requireAuth, async (req, res) => {
  const source = await getSourceForUser(req.params.sourceId, req.currentUser.id)
  if (!source) {
    return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
  }

  try {
    const eventsByKey = await ical.async.fromURL(source.source_url)
    const rawEvents = Object.values(eventsByKey).filter((item) => item?.type === 'VEVENT')
    const detectedTimezone = detectTimezoneFromFeed(eventsByKey)
    
    // Get first 5 raw events with their key properties
    const sampleEvents = rawEvents.slice(0, 5).map(e => ({
      summary: e.summary,
      start: e.start,
      startType: typeof e.start,
      startTz: e.start?.tz,
      end: e.end,
      hasRrule: !!e.rrule,
      rruleStr: e.rrule?.toString?.()?.slice(0, 200),
      uid: e.uid?.slice(0, 50),
    }))
    
    // Expand and get first 10 expanded events
    const expanded = expandRecurringEvents(rawEvents.slice(0, 10), detectedTimezone)
    const sampleExpanded = expanded.slice(0, 10).map(e => ({
      summary: e.summary,
      start: e.start?.toISOString?.(),
      end: e.end?.toISOString?.(),
      uid: e.uid?.slice(0, 50),
    }))
    
    res.json({
      sourceId: source.id,
      sourceType: source.source_type,
      detectedTimezone,
      rawEventCount: rawEvents.length,
      expandedEventCount: expanded.length,
      sampleRawEvents: sampleEvents,
      sampleExpandedEvents: sampleExpanded,
    })
  } catch (error) {
    res.status(500).json({ 
      error: { message: error.message || 'Debug failed', status: 500 },
      stack: error.stack?.slice(0, 500),
    })
  }
})

app.post('/api/purdue/calendar-link/start', requireAuth, requirePurdueLinked, async (req, res) => {
  try {
    const job = await startCalendarCapture(req.currentUser.id)
    res.status(202).json({ job })
  } catch (error) {
    res.status(500).json({ error: { message: error.message || 'Could not start Purdue timetable automation.', status: 500 } })
  }
})

app.get('/api/purdue/calendar-link/status', requireAuth, requirePurdueLinked, async (req, res) => {
  res.json({ job: getCalendarCaptureJob(req.currentUser.id) })
})

app.post('/api/purdue/calendar-link/cancel', requireAuth, requirePurdueLinked, async (req, res) => {
  res.json({ job: await cancelCalendarCapture(req.currentUser.id) })
})

app.post('/api/sources/purdue/schedule', sourceSyncRateLimit, requireAuth, requirePurdueLinked, async (req, res) => {
  const userId = req.currentUser.id
  const { icsUrl, label } = req.body

  // Validate URL
  if (!icsUrl || typeof icsUrl !== 'string' || icsUrl.trim().length < 10) {
    return res.status(400).json({ error: { message: 'Please provide a valid calendar URL.', status: 400 } })
  }

  const trimmedUrl = icsUrl.trim()

  // Check for common URL issues
  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    return res.status(400).json({ error: { message: 'Calendar URL must start with http:// or https://', status: 400 } })
  }

  // Warn if URL doesn't look like a typical Purdue timetable URL
  const isPurdueUrl = trimmedUrl.includes('purdue.edu') || trimmedUrl.includes('mypurdue')
  if (!isPurdueUrl) {
    console.warn(`[/api/sources/purdue/schedule] User ${userId} connecting non-Purdue URL: ${trimmedUrl.slice(0, 80)}...`)
  }

  try {
    console.log(`[/api/sources/purdue/schedule] User ${userId} creating source...`)
    const source = await createScheduleSource(userId, { icsUrl: trimmedUrl, label })
    
    console.log(`[/api/sources/purdue/schedule] User ${userId} syncing source ${source.id}...`)
    const sync = await runScheduleSync(source)
    
    console.log(`[/api/sources/purdue/schedule] User ${userId} sync complete: ${sync.itemCount} items`)
    res.status(201).json({ source: await getSourceForUser(source.id, userId), sync })
  } catch (error) {
    console.error(`[/api/sources/purdue/schedule] User ${userId} error:`, error?.message || error)
    res.status(400).json({ error: { message: error.message || 'Could not connect the Purdue schedule source.', status: 400 } })
  }
})

app.post('/api/sources/brightspace/schedule', sourceSyncRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { icsUrl, label } = req.body

  // Validate URL
  if (!icsUrl || typeof icsUrl !== 'string' || icsUrl.trim().length < 10) {
    return res.status(400).json({ error: { message: 'Please provide a calendar URL.', status: 400 } })
  }

  const trimmedUrl = icsUrl.trim()

  // Check for common URL issues
  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    return res.status(400).json({ error: { message: 'Calendar URL must start with http:// or https://', status: 400 } })
  }

  // Validate Brightspace URL format (but be flexible)
  const isBrightspaceUrl = trimmedUrl.includes('brightspace.com') || trimmedUrl.includes('d2l')
  if (!isBrightspaceUrl) {
    console.warn(`[/api/sources/brightspace/schedule] User ${userId} connecting non-Brightspace URL: ${trimmedUrl.slice(0, 80)}...`)
    // Still allow it but log the warning
  }

  try {
    console.log(`[/api/sources/brightspace/schedule] User ${userId} creating source...`)
    const source = await createScheduleSource(userId, { 
      icsUrl: trimmedUrl, 
      label: label || 'Brightspace Calendar',
      sourceType: 'brightspace_ical'
    })
    
    console.log(`[/api/sources/brightspace/schedule] User ${userId} syncing source ${source.id}...`)
    const sync = await runScheduleSync(source)
    
    console.log(`[/api/sources/brightspace/schedule] User ${userId} sync complete: ${sync.itemCount} items`)
    res.status(201).json({ source: await getSourceForUser(source.id, userId), sync })
  } catch (error) {
    console.error(`[/api/sources/brightspace/schedule] User ${userId} error:`, error?.message || error)
    res.status(400).json({ error: { message: error.message || 'Could not connect the Brightspace calendar.', status: 400 } })
  }
})

app.post('/api/sync/:sourceId', sourceSyncRateLimit, requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const sourceId = req.params.sourceId
  
  const source = await getSourceForUser(sourceId, userId)
  if (!source) {
    return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
  }
  
  try {
    console.log(`[/api/sync] User ${userId} re-syncing source ${sourceId}...`)
    const sync = await runScheduleSync(source)
    console.log(`[/api/sync] User ${userId} sync complete: ${sync.itemCount} items`)
    
    const response = { source: await getSourceForUser(sourceId, userId), sync }
    
    // Include warning in response if some items were skipped
    if (sync.skippedCount > 0) {
      response.warning = `${sync.skippedCount} items had invalid dates and were skipped.`
    }
    
    res.json(response)
  } catch (error) {
    console.error(`[/api/sync] User ${userId} source ${sourceId} error:`, error?.message || error)
    res.status(400).json({ error: { message: error.message || 'Could not sync source.', status: 400 } })
  }
})

app.delete('/api/sources/:sourceId', requireAuth, async (req, res) => {
  const source = await getSourceForUser(req.params.sourceId, req.currentUser.id)
  if (!source) {
    return res.status(404).json({ error: { message: 'Source not found.', status: 404 } })
  }
  try {
    // Delete all calendar items for this source
    await supabase
      .from('calendar_items')
      .delete()
      .eq('source_id', source.id)
    
    // Delete the source itself
    await supabase
      .from('linked_sources')
      .delete()
      .eq('id', source.id)
    
    res.json({ ok: true, message: 'Source and all associated items deleted.' })
  } catch (error) {
    res.status(400).json({ error: { message: error.message || 'Could not delete source.', status: 400 } })
  }
})

app.get('/api/me/calendar', requireAuth, async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : null
  const categories = typeof req.query.categories === 'string' ? req.query.categories.split(',').filter(Boolean) : null
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100
  const from = typeof req.query.from === 'string' ? req.query.from : null
  res.json({ items: await listCalendarItems(req.currentUser.id, { category, categories, limit, order: 'asc', from }) })
})

app.get('/api/me/calendar/categories', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('calendar_items')
    .select('category')
    .eq('user_id', req.currentUser.id)

  if (error) {
    return res.json({ categories: [] })
  }

  const counts = {}
  for (const row of data) {
    counts[row.category] = (counts[row.category] || 0) + 1
  }

  const categoryLabels = {
    class: 'Classes',
    exam: 'Exams',
    assignment: 'Assignments',
    lab: 'Labs',
    project: 'Projects',
    quiz: 'Quizzes',
    campus_event: 'Campus Events',
    resource: 'Resources',
    deadline: 'Deadlines',
    event: 'Other Events'
  }

  const categories = Object.entries(counts)
    .map(([key, count]) => ({
      id: key,
      label: categoryLabels[key] || key,
      count
    }))
    .sort((a, b) => b.count - a.count)

  res.json({ categories })
})

// ── Tasks: mark calendar rows done + user-created dated tasks (see supabase-user-tasks.sql) ──

function mapManualTaskRow(row) {
  return {
    id: row.id,
    title: row.title,
    startTime: row.due_at,
    endTime: null,
    category: 'manual_task',
    sourceType: 'manual',
    description: null,
    location: null,
    externalUid: null,
    sourceId: null,
    completedAt: row.completed_at,
    isManual: true,
  }
}

app.get('/api/me/tasks/meta', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  try {
    const [compRes, manualRes] = await Promise.all([
      supabase
        .from('user_task_completions')
        .select('calendar_item_id, completed_at')
        .eq('user_id', userId),
      supabase.from('user_manual_tasks').select('*').eq('user_id', userId).order('due_at', { ascending: true }),
    ])
    if (compRes.error) throw compRes.error
    if (manualRes.error) throw manualRes.error
    res.json({
      completions: compRes.data || [],
      manualTasks: (manualRes.data || []).map(mapManualTaskRow),
    })
  } catch (e) {
    console.error('GET /api/me/tasks/meta:', e?.message || e)
    res.json({ completions: [], manualTasks: [], unavailable: true })
  }
})

app.post('/api/me/tasks/calendar/complete', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { calendarItemId, completed } = req.body || {}
  if (!calendarItemId || typeof completed !== 'boolean') {
    return res.status(400).json({ error: { message: 'calendarItemId and completed (boolean) required' } })
  }
  const { data: row, error: findErr } = await supabase
    .from('calendar_items')
    .select('id')
    .eq('id', calendarItemId)
    .eq('user_id', userId)
    .maybeSingle()
  if (findErr || !row) {
    return res.status(404).json({ error: { message: 'Calendar item not found' } })
  }
  try {
    if (completed) {
      const { error: insErr } = await supabase.from('user_task_completions').insert({
        user_id: userId,
        calendar_item_id: calendarItemId,
        completed_at: nowIso(),
      })
      if (insErr) {
        if (insErr.code === '23505') {
          const { error: updErr } = await supabase
            .from('user_task_completions')
            .update({ completed_at: nowIso() })
            .eq('user_id', userId)
            .eq('calendar_item_id', calendarItemId)
          if (updErr) throw updErr
        } else {
          throw insErr
        }
      }
    } else {
      const { error } = await supabase
        .from('user_task_completions')
        .delete()
        .eq('user_id', userId)
        .eq('calendar_item_id', calendarItemId)
      if (error) throw error
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('POST /api/me/tasks/calendar/complete:', e)
    res.status(500).json({ error: { message: e.message || 'Could not update completion' } })
  }
})

app.post('/api/me/tasks/manual', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { title, dueAt } = req.body || {}
  const t = String(title || '').trim()
  if (!t || t.length > 500) {
    return res.status(400).json({ error: { message: 'Title is required (max 500 characters)' } })
  }
  if (!dueAt || typeof dueAt !== 'string') {
    return res.status(400).json({ error: { message: 'dueAt ISO timestamp is required' } })
  }
  const due = new Date(dueAt)
  if (Number.isNaN(due.getTime())) {
    return res.status(400).json({ error: { message: 'Invalid dueAt date' } })
  }
  try {
    const { data, error } = await supabase
      .from('user_manual_tasks')
      .insert({
        user_id: userId,
        title: t,
        due_at: due.toISOString(),
      })
      .select()
      .single()
    if (error) throw error
    res.json({ task: mapManualTaskRow(data) })
  } catch (e) {
    console.error('POST /api/me/tasks/manual:', e)
    res.status(500).json({ error: { message: e.message || 'Could not create task' } })
  }
})

app.patch('/api/me/tasks/manual/:id', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  const { completed, title, dueAt } = req.body || {}
  const updates = {}
  if (typeof completed === 'boolean') {
    updates.completed_at = completed ? nowIso() : null
  }
  if (typeof title === 'string' && title.trim()) {
    updates.title = title.trim().slice(0, 500)
  }
  if (typeof dueAt === 'string') {
    const due = new Date(dueAt)
    if (!Number.isNaN(due.getTime())) updates.due_at = due.toISOString()
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: { message: 'No valid fields to update' } })
  }
  try {
    const { data, error } = await supabase
      .from('user_manual_tasks')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()
    if (error) throw error
    if (!data) return res.status(404).json({ error: { message: 'Task not found' } })
    res.json({ task: mapManualTaskRow(data) })
  } catch (e) {
    console.error('PATCH /api/me/tasks/manual:', e)
    res.status(500).json({ error: { message: e.message || 'Could not update task' } })
  }
})

app.delete('/api/me/tasks/manual/:id', requireAuth, async (req, res) => {
  const userId = req.currentUser.id
  const { id } = req.params
  try {
    const { error } = await supabase.from('user_manual_tasks').delete().eq('id', id).eq('user_id', userId)
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/me/tasks/manual:', e)
    res.status(500).json({ error: { message: e.message || 'Could not delete task' } })
  }
})

app.get('/api/me/classes', requireAuth, async (req, res) => {
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20
  const term = typeof req.query.term === 'string' ? req.query.term : 'auto'
  const mode = typeof req.query.mode === 'string' ? req.query.mode : 'display'
  const data = await getClassItemsForUser(req.currentUser.id, { limit, term, mode })
  res.json(data)
})

app.get('/api/me/events', requireAuth, async (req, res) => {
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20
  res.json({ items: await listCalendarItems(req.currentUser.id, { category: 'event', limit, order: 'asc' }) })
})

app.get('/', (_req, res) => {
  res.redirect(clientAppUrl)
})

// ============================================================
// Gemini campus assistant
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
const TZ = 'America/Indiana/Indianapolis'

// In-memory rate limiter: keyed by user ID (authed) or IP (anon)
const _geminiWindows = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _geminiWindows) if (now >= v.resetAt) _geminiWindows.delete(k)
}, 60 * 60 * 1000)

function geminiAllowed(key, max) {
  const now = Date.now()
  const win = _geminiWindows.get(key)
  if (!win || now >= win.resetAt) {
    _geminiWindows.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 })
    return true
  }
  if (win.count >= max) return false
  win.count++
  return true
}

const CAMPUS_SYSTEM_PROMPT = `You are BoilerIndy — a helpful campus assistant for Purdue University Indianapolis (Purdue Indy / IUPUI).
You have access to real-time data about the student's schedule, dining, and campus events — all provided in the context block below.
Use that data to answer questions directly and accurately. Do not tell the student to "check the app" or "check the tab" when the answer is already in the context.

You help students with:
- Their personal class schedule (including earlier today and what's in session), upcoming assignments, exams, and due dates (from context)
- Dining hours and today's menu at each location (from context)
- Campus / career / optional events (from context)
- Where to study and get help on campus (use the ON-CAMPUS STUDY & HELP section when relevant)
- Campus transit/buses: Crimson & Gray routes run Mon–Fri 6:30am–10pm; Yellow & Blue run Mon–Fri 5:30am–midnight; Purple runs Mon–Fri 7am–10pm; Orange runs Sat–Sun 9am–8pm
- Buildings: ET Building (engineering/tech), Campus Center (dining, student services), University Library, Science & Engineering Lab Building (SL), Cavanaugh Hall (CA), Hine Hall (HH), Madam Walker Legacy Center, IUPUI Tower
- Student services: ASC tutoring (Campus Center 2nd floor), printing (library 25 free pages/day), Health & Wellness Center, Financial Aid (Cavanaugh Hall), Registrar (Cavanaugh Hall)
- General student life at Purdue Indy

Rules:
- Be concise and friendly. For simple questions: 2–4 sentences. For "what should I do now?", "plan my afternoon", or similar planning questions: give a short prioritized plan (3–6 sentences or brief bullets), because multiple commitments may apply.
- Answer directly from the context data when available — do not hedge or defer.
- When the student asks what to do *now*, *next*, or how to balance their time: anchor on CURRENT DATE & TIME. Weigh together: (1) anything in HAPPENING NOW, (2) classes or exams starting within the next ~2 hours, (3) homework or projects due in the next 24–48 hours (especially tonight), (4) upcoming exams/quizzes that need prep time, (5) optional campus events. Do **not** push optional events over urgent coursework or tight deadlines unless they are clearly free.
- If homework is due tonight, say so and suggest when to work on it relative to class, meals, and events already on their calendar.
- For exam prep or heavy homework blocks, suggest concrete on-campus options from the STUDY & HELP section (e.g. library quiet floors, ET/SL for STEM, ASC tutoring for support — match to subject when possible).
- For "next class" questions only count regular lectures/labs/discussions, not exams or office hours (unless asked).
- If something is genuinely unknown (not in context and not general knowledge), say so briefly.
- If asked about something totally unrelated to campus life, briefly redirect.`

// ── Context formatters ────────────────────────────────────────────────────────

function fmtTime(isoStr, opts = {}) {
  return new Date(isoStr).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', ...opts })
}
function fmtDate(isoStr) {
  return new Date(isoStr).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' })
}

function buildDiningContext(dining) {
  if (!dining?.ok || !dining.locations?.length) return ''
  const lines = [`=== DINING TODAY (${dining.date}) ===`]
  for (const loc of dining.locations) {
    const status = loc.is_open ? 'OPEN' : 'CLOSED'
    const hrs = loc.hours && loc.hours !== 'Closed today' ? ` — ${loc.hours}` : ''
    lines.push(`${loc.name}: ${status}${hrs}`)
    if (loc.stations?.length) {
      for (const station of loc.stations) {
        const items = (station.items || []).slice(0, 8).map(it => {
          const tags = (it.icons || []).filter(t => ['Vegan', 'Vegetarian', 'Avoiding Gluten'].includes(t))
          return `${it.name}${it.calories ? ` ${it.calories}cal` : ''}${tags.length ? ` (${tags.join('/')})` : ''}`
        })
        if (items.length) lines.push(`  ${station.name}: ${items.join(', ')}`)
      }
    } else if (loc.meal) {
      lines.push(`  Menus: ${loc.meal}`)
    }
  }
  return lines.join('\n')
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

/** Rich calendar context for /api/assistant: today, ongoing, exams, assignments, events, study hints. */
function buildAssistantCalendarContext(calendarData, now) {
  if (!calendarData?.length) {
    return '=== CALENDAR ===\nNo calendar items in the fetched window.'
  }

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
        .map((i) => `- Until ${fmtTime(i.end_time)}: ${i.title} [${i.category}]${i.location ? ` @ ${i.location}` : ''}`)
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
    parts.push(`=== TODAY (${dayLabel}) — everything with times (Eastern) ===`)
    parts.push(
      todayRows
        .map((i) => {
          const range = i.end_time
            ? `${fmtTime(i.start_time)}–${fmtTime(i.end_time)}`
            : fmtTime(i.start_time)
          return `- ${range}: ${i.title} [${i.category}]${i.location ? ` @ ${i.location}` : ''}`
        })
        .join('\n'),
    )
  }

  if (assignmentRows.length) {
    parts.push('=== UPCOMING ASSIGNMENTS / HOMEWORK / DEADLINES ===')
    parts.push(
      assignmentRows
        .map((i) => `- Due ${fmtDate(i.start_time)} ${fmtTime(i.start_time)}: ${i.title}${i.location ? ` (${i.location})` : ''} [${i.category}]`)
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

  parts.push(`=== ON-CAMPUS STUDY & HELP (suggest when relevant) ===
- University Library: quiet floors, study rooms, printing (25 free pages/day).
- ET Building & Science/Engineering Lab (SL): strong for STEM work between classes.
- Cavanaugh Hall & Hine Hall: lounges for shorter sessions.
- ASC tutoring: Campus Center 2nd floor — math, writing, coaching (check hours).
- Campus Center: food and space to regroup before/after events.`)

  return parts.join('\n\n')
}

app.post('/api/assistant', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Assistant not configured.' })
  }

  const rlKey = req.session?.userId || req.ip || 'anon'
  if (!geminiAllowed(rlKey, 20)) {
    return res.status(429).json({ error: 'Rate limit reached. Try again in an hour.' })
  }

  const { messages } = req.body
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' })
  }

  const now = new Date()
  const nowISOStr = now.toISOString()
  const fourWeeksOut = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString()
  const nowLabel = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const timeLabel = now.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })

  // Fetch all context in parallel
  const [diningData, calendarData] = await Promise.all([
    getDiningSnapshot({}).catch(() => null),
    (async () => {
      try {
        const user = await getCurrentUser(req)
        if (!user) return null
        const lowerBound = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
        const sel = 'id, title, start_time, end_time, location, category'
        const [upcomingRes, ongoingRes] = await Promise.all([
          supabase
            .from('calendar_items')
            .select(sel)
            .eq('user_id', user.id)
            .gte('start_time', lowerBound)
            .lte('start_time', fourWeeksOut)
            .order('start_time', { ascending: true })
            .limit(100),
          supabase
            .from('calendar_items')
            .select(sel)
            .eq('user_id', user.id)
            .lt('start_time', nowISOStr)
            .gt('end_time', nowISOStr)
            .limit(25),
        ])
        const upcoming = upcomingRes.data || []
        const ongoingRows = ongoingRes.data || []
        const byId = new Map()
        for (const r of ongoingRows) byId.set(r.id, r)
        for (const r of upcoming) byId.set(r.id, r)
        return [...byId.values()].sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
      } catch {
        return null
      }
    })(),
  ])

  const diningCtx = buildDiningContext(diningData)
  const calendarCtx = calendarData ? buildAssistantCalendarContext(calendarData, now) : ''

  const contextBlock = [
    `=== CURRENT DATE & TIME ===\n${nowLabel} at ${timeLabel} (Eastern)`,
    diningCtx,
    calendarCtx,
  ].filter(Boolean).join('\n\n')

  const systemPrompt = CAMPUS_SYSTEM_PROMPT + '\n\n' + contextBlock

  const contents = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 2800, temperature: 0.52 },
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('Gemini error:', err)
      return res.status(502).json({ error: 'AI service error' })
    }

    const data = await response.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "Sorry, I couldn't generate a response."
    res.json({ reply: text })
  } catch (err) {
    console.error('Assistant error:', err)
    res.status(500).json({ error: 'Assistant request failed' })
  }
})

// TransLoc API proxy endpoints (to avoid CORS issues)
const TRANSLOC_API = 'https://iuindianapolis.transloc.com/Services/JSONPRelay.svc'
const TRANSLOC_API_KEY = '8882812681'

app.get('/api/transit/vehicles', async (_req, res) => {
  try {
    const response = await fetch(`${TRANSLOC_API}/GetMapVehiclePoints?apiKey=${TRANSLOC_API_KEY}&isPublicMap=true`)
    const data = await response.json()
    res.json(data)
  } catch (error) {
    console.error('TransLoc vehicles error:', error)
    res.status(500).json({ error: 'Failed to fetch vehicle data' })
  }
})

app.get('/api/transit/stops', async (_req, res) => {
  try {
    const response = await fetch(`${TRANSLOC_API}/GetStops?apiKey=${TRANSLOC_API_KEY}`)
    const data = await response.json()
    res.json(data)
  } catch (error) {
    console.error('TransLoc stops error:', error)
    res.status(500).json({ error: 'Failed to fetch stops data' })
  }
})

app.get('/api/transit/routes', async (_req, res) => {
  try {
    const response = await fetch(`${TRANSLOC_API}/GetRoutes?apiKey=${TRANSLOC_API_KEY}`)
    const data = await response.json()
    res.json(data)
  } catch (error) {
    console.error('TransLoc routes error:', error)
    res.status(500).json({ error: 'Failed to fetch routes data' })
  }
})

app.get('/api/dining', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true'
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined
    const data = await getDiningSnapshot({ forceRefresh, date })
    res.json(data)
  } catch (error) {
    console.error('Nutrislice dining error:', error)
    res.status(500).json({ ok: false, error: 'dining_internal', locations: [] })
  }
})

// ============================================================
// Board API
// ============================================================

const BOARD_SQL_FILE = 'supabase-board-only.sql'

function isBoardSchemaMissingError(err) {
  const m = String(err?.message || '')
  const c = String(err?.code || '')
  return (
    m.includes('schema cache') ||
    m.includes('Could not find the table') ||
    m.includes('does not exist') && m.includes('board_posts') ||
    c === 'PGRST205' ||
    c === '42P01'
  )
}

function respondBoardDbError(res, err) {
  console.error('Board DB error:', err?.message || err, err?.code, err?.details)
  if (isBoardSchemaMissingError(err)) {
    return res.status(503).json({
      error: {
        message: `Campus board tables are missing in Supabase. In the dashboard: SQL Editor → paste and run the file ${BOARD_SQL_FILE} from this repo → Run. Wait a few seconds, then try again.`,
        code: 'board_schema_missing',
        status: 503,
      },
    })
  }
  return res.status(500).json({
    error: { message: err?.message || 'Database error', status: 500 },
  })
}

app.get('/api/board/posts', requireAuth, async (req, res) => {
  const sort = req.query.sort === 'popular' ? 'popular' : 'recent'

  // select('*') keeps the board working whether or not the optional
  // edited_at migration (supabase-board-only.sql) has been applied yet
  let query = supabase
    .from('board_posts')
    .select('*')
  if (sort === 'popular') {
    query = query
      .order('pinned', { ascending: false })
      .order('upvote_count', { ascending: false })
      .order('created_at', { ascending: false })
  } else {
    query = query
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
  }
  const { data: postsData, error: postsError } = await query.limit(100)
  if (postsError) return respondBoardDbError(res, postsError)

  const postIds = postsData.map(p => p.id)
  let repliesData = []
  if (postIds.length > 0) {
    const { data: rd } = await supabase
      .from('board_replies')
      .select('id, post_id, body, is_anon, created_at, user_id')
      .in('post_id', postIds)
      .order('created_at', { ascending: true })
    repliesData = rd || []
  }

  // Batch-fetch display names for all non-anonymous user IDs
  const allUserIds = new Set()
  for (const p of postsData) { if (!p.is_anon) allUserIds.add(p.user_id) }
  for (const r of repliesData) { if (!r.is_anon) allUserIds.add(r.user_id) }
  const nameMap = {}
  if (allUserIds.size > 0) {
    const { data: usersData } = await supabase
      .from('users')
      .select('id, display_name')
      .in('id', [...allUserIds])
    if (usersData) {
      for (const u of usersData) nameMap[u.id] = u.display_name
    }
  }

  let upvotedIds = new Set()
  if (postIds.length > 0) {
    const { data: uv } = await supabase
      .from('board_upvotes')
      .select('post_id')
      .eq('user_id', req.currentUser.id)
      .in('post_id', postIds)
    if (uv) uv.forEach(r => upvotedIds.add(r.post_id))
  }

  const repliesByPost = {}
  for (const reply of repliesData) {
    if (!repliesByPost[reply.post_id]) repliesByPost[reply.post_id] = []
    repliesByPost[reply.post_id].push({
      id: reply.id,
      body: reply.body,
      user: reply.is_anon ? 'Anonymous' : (nameMap[reply.user_id] || 'Student'),
      time: reply.created_at,
    })
  }

  const myId = req.currentUser.id
  const posts = postsData.map(p => ({
    id: p.id,
    title: p.title,
    body: p.body,
    anon: p.is_anon,
    user: p.is_anon ? 'Anonymous' : (nameMap[p.user_id] || 'Student'),
    upvotes: p.upvote_count,
    pinned: p.pinned,
    hot: !p.pinned && p.upvote_count >= 10,
    time: p.created_at,
    tags: Array.isArray(p.tags) ? p.tags : [],
    editedTime: p.edited_at || null,
    upvotedByMe: upvotedIds.has(p.id),
    isMine: p.user_id === myId,
    replies: repliesByPost[p.id] || [],
  }))

  res.json({ posts })
})

const BOARD_TAG_CANDIDATES = [
  'dining', 'parking', 'tutoring', 'housing', 'transit', 'library',
  'career', 'health', 'clubs', 'sports', 'tech', 'financial-aid',
  'study-spots', 'events', 'classes', 'safety',
]

app.post('/api/board/ai-suggestions', requireAuth, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      error: { message: 'AI suggestions are not configured.', status: 503 },
    })
  }

  if (!geminiAllowed(req.session.userId, 10)) {
    return res.status(429).json({
      error: { message: 'Rate limit reached. Try again in an hour.', status: 429 },
    })
  }
  const context = req.body.context === 'reply' ? 'reply' : 'compose'
  const title = String(req.body.title || '').trim().slice(0, 300)
  const body = String(req.body.body || '').trim().slice(0, 1200)
  const postTitle = String(req.body.postTitle || '').trim().slice(0, 300)
  const postBody = String(req.body.postBody || '').trim().slice(0, 800)
  const draft = String(req.body.draft || '').trim().slice(0, 1000)

  if (context === 'compose') {
    if (title.length < 6 && body.length < 20) {
      return res.json({ betterTitle: null, bodyAddOn: null, tags: [] })
    }
  } else if (draft.length < 8) {
    return res.json({ replyTip: null })
  }

  const tagList = BOARD_TAG_CANDIDATES.join(', ')
  const userText =
    context === 'compose'
      ? `The student is composing a question for a Purdue Indianapolis campus board.\n\nTitle (draft):\n${title}\n\nBody (draft):\n${body || '(empty)'}\n\nReturn ONLY a JSON object, no markdown code fences, with this exact shape:\n{"betterTitle":string|null,"bodyAddOn":string|null,"tags":string[]}\n\n- betterTitle: a clearer full title under 120 characters, or null if the draft title is already good.\n- bodyAddOn: one short optional sentence they could add for context (location, course, deadline), or null if not needed.\n- tags: 0 to 3 items, each must be exactly one of: ${tagList}\nUse JSON null (not the string "null") where appropriate.`
      : `Campus board thread title: ${postTitle}\nOriginal post:\n${postBody || '(no body)'}\n\nStudent's reply draft:\n${draft}\n\nReturn ONLY JSON: {"replyTip":string|null} — one concise coaching sentence (tone, specificity, or missing info), or null if the draft is fine.`

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { maxOutputTokens: 350, temperature: 0.35 },
      }),
    })
    if (!response.ok) {
      console.error('Board AI suggestions:', await response.text())
      return res.status(502).json({ error: { message: 'AI service error', status: 502 } })
    }
    const data = await response.json()
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      return context === 'compose'
        ? res.json({ betterTitle: null, bodyAddOn: null, tags: [] })
        : res.json({ replyTip: null })
    }
    let parsed
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return context === 'compose'
        ? res.json({ betterTitle: null, bodyAddOn: null, tags: [] })
        : res.json({ replyTip: null })
    }

    if (context === 'compose') {
      const betterTitle =
        typeof parsed.betterTitle === 'string' ? parsed.betterTitle.trim().slice(0, 120) : null
      const bodyAddOn =
        typeof parsed.bodyAddOn === 'string' ? parsed.bodyAddOn.trim().slice(0, 400) : null
      const tags = Array.isArray(parsed.tags)
        ? parsed.tags
            .filter((t) => typeof t === 'string' && BOARD_TAG_CANDIDATES.includes(t.toLowerCase()))
            .map((t) => t.toLowerCase())
            .slice(0, 3)
        : []
      res.json({
        betterTitle: betterTitle || null,
        bodyAddOn: bodyAddOn || null,
        tags,
      })
    } else {
      const replyTip =
        typeof parsed.replyTip === 'string' ? parsed.replyTip.trim().slice(0, 240) : null
      res.json({ replyTip: replyTip || null })
    }
  } catch (e) {
    console.error('Board AI suggestions:', e?.message || e)
    return res.status(500).json({ error: { message: 'Suggestion request failed', status: 500 } })
  }
})

async function autoTagBoardPost(postId, title, body) {
  if (!GEMINI_API_KEY) return []
  const combined = `${title}\n${body}`.slice(0, 400)
  try {
    const resp = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: `You are a campus board post auto-tagger. Given a student's post, pick 1-3 of the most relevant tags from this list: ${BOARD_TAG_CANDIDATES.join(', ')}. Return ONLY a JSON array of strings, e.g. ["dining","parking"]. If nothing fits, return [].`,
          }],
        },
        contents: [{ role: 'user', parts: [{ text: combined }] }],
        generationConfig: { maxOutputTokens: 60, temperature: 0.1 },
      }),
    })
    if (!resp.ok) return []
    const data = await resp.json()
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]'
    const match = raw.match(/\[.*\]/)
    if (!match) return []
    const parsed = JSON.parse(match[0])
    const tags = parsed
      .filter((t) => typeof t === 'string' && BOARD_TAG_CANDIDATES.includes(t.toLowerCase()))
      .map((t) => t.toLowerCase())
      .slice(0, 3)
    if (tags.length) {
      await supabase.from('board_posts').update({ tags }).eq('id', postId)
    }
    return tags
  } catch (e) {
    console.error('Auto-tag error:', e?.message || e)
    return []
  }
}

app.post('/api/board/posts', boardWriteRateLimit, requireAuth, async (req, res) => {
  const title = String(req.body.title || '').trim()
  const body  = String(req.body.body  || '').trim()
  const isAnon = req.body.anon === true || req.body.anon === 'true'

  if (!title) return res.status(400).json({ error: { message: 'Title is required.', status: 400 } })
  if (title.length > 300) return res.status(400).json({ error: { message: 'Title must be 300 characters or fewer.', status: 400 } })

  const profanityCheck = assertBoardPostTextAllowed(title, body)
  if (!profanityCheck.ok) {
    return res.status(400).json({ error: { message: profanityCheck.message, status: 400 } })
  }

  const userId = req.currentUser.id
  if (!userId) {
    return res.status(401).json({ error: { message: 'Invalid session.', status: 401 } })
  }

  const { data, error } = await supabase
    .from('board_posts')
    .insert({
      user_id: userId,
      title,
      body: body || '',
      is_anon: isAnon,
    })
    .select('id, title, body, is_anon, pinned, upvote_count, reply_count, created_at')
    .single()

  if (error) {
    console.error('board_posts insert:', error.message, error.code, error.details)
    return respondBoardDbError(res, error)
  }

  // Fire-and-forget: AI assigns tags in the background
  const tagsPromise = autoTagBoardPost(data.id, title, body)

  // Respond immediately so the UI doesn't block on AI
  const postPayload = {
    id: data.id,
    title: data.title,
    body: data.body,
    anon: data.is_anon,
    user: data.is_anon ? 'Anonymous' : (req.currentUser.display_name || 'Student'),
    upvotes: 0,
    pinned: false,
    hot: false,
    time: data.created_at,
    upvotedByMe: false,
    isMine: true,
    tags: [],
    replies: [],
  }

  // Wait briefly (200ms) in case AI is fast, so the user sees tags immediately
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 200))
  const quickTags = await Promise.race([tagsPromise, timeout])
  if (Array.isArray(quickTags) && quickTags.length) {
    postPayload.tags = quickTags
  }

  res.status(201).json({ post: postPayload })
})

app.post('/api/board/posts/:id/reply', boardWriteRateLimit, requireAuth, async (req, res) => {
  const postId = req.params.id
  const body   = String(req.body.body || '').trim()
  const isAnon = req.body.anon === true || req.body.anon === 'true'

  if (!body) return res.status(400).json({ error: { message: 'Reply body is required.', status: 400 } })
  if (boardTextFailsPolicy(body)) {
    return res.status(400).json({ error: { message: BOARD_PROFANITY_USER_MESSAGE, status: 400 } })
  }

  const { data: post, error: postError } = await supabase
    .from('board_posts')
    .select('id, reply_count')
    .eq('id', postId)
    .single()
  if (postError) return respondBoardDbError(res, postError)
  if (!post) return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })

  const id = makeId()
  const timestamp = nowIso()
  const { data: reply, error: replyError } = await supabase
    .from('board_replies')
    .insert({ id, post_id: postId, user_id: req.currentUser.id, body, is_anon: isAnon, created_at: timestamp })
    .select('id, body, is_anon, created_at')
    .single()

  if (replyError) return respondBoardDbError(res, replyError)

  await supabase
    .from('board_posts')
    .update({ reply_count: post.reply_count + 1, updated_at: nowIso() })
    .eq('id', postId)

  res.status(201).json({
    reply: {
      id: reply.id,
      body: reply.body,
      user: reply.is_anon ? 'Anonymous' : req.currentUser.display_name,
      time: reply.created_at,
    }
  })
})

app.post('/api/board/posts/:id/upvote', boardWriteRateLimit, requireAuth, async (req, res) => {
  const postId = req.params.id
  const userId = req.currentUser.id

  const { data: post, error: postError } = await supabase
    .from('board_posts')
    .select('id, upvote_count')
    .eq('id', postId)
    .single()
  if (postError) return respondBoardDbError(res, postError)
  if (!post) return res.status(404).json({ error: { message: 'Post not found.', status: 404 } })

  const { error: insertError } = await supabase
    .from('board_upvotes')
    .insert({ post_id: postId, user_id: userId, created_at: nowIso() })

  let newCount, upvotedByMe
  if (insertError && insertError.code === '23505') {
    await supabase.from('board_upvotes').delete().eq('post_id', postId).eq('user_id', userId)
    newCount = Math.max(0, post.upvote_count - 1)
    upvotedByMe = false
  } else if (insertError) {
    return respondBoardDbError(res, insertError)
  } else {
    newCount = post.upvote_count + 1
    upvotedByMe = true
  }

  await supabase.from('board_posts').update({ upvote_count: newCount, updated_at: nowIso() }).eq('id', postId)
  res.json({ upvotes: newCount, upvotedByMe })
})

// Owner-only edit of a post's title/body (issue #7)
app.patch('/api/board/posts/:id', boardWriteRateLimit, requireAuth, async (req, res) => {
  const postId = req.params.id
  const userId = req.currentUser.id
  const title = String(req.body.title ?? '').trim()
  const body = String(req.body.body ?? '').trim()

  if (!title) return res.status(400).json({ error: { message: 'Title is required.', status: 400 } })
  if (title.length > 300) {
    return res.status(400).json({ error: { message: 'Title must be 300 characters or fewer.', status: 400 } })
  }

  const profanityCheck = assertBoardPostTextAllowed(title, body)
  if (!profanityCheck.ok) {
    return res.status(400).json({ error: { message: profanityCheck.message, status: 400 } })
  }

  const editedAt = nowIso()
  let { data, error } = await supabase
    .from('board_posts')
    .update({ title, body, edited_at: editedAt, updated_at: editedAt })
    .eq('id', postId)
    .eq('user_id', userId)
    .select('*')

  // Retry without edited_at when the optional column migration hasn't run yet
  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    ;({ data, error } = await supabase
      .from('board_posts')
      .update({ title, body, updated_at: editedAt })
      .eq('id', postId)
      .eq('user_id', userId)
      .select('*'))
  }

  if (error) return respondBoardDbError(res, error)
  if (!data?.length) {
    return res.status(404).json({
      error: { message: 'Post not found or you can only edit your own posts.', status: 404 },
    })
  }

  const post = data[0]
  res.json({
    post: {
      id: post.id,
      title: post.title,
      body: post.body,
      editedTime: post.edited_at || editedAt,
    },
  })
})

app.delete('/api/board/posts/:id', requireAuth, async (req, res) => {
  const postId = req.params.id
  const userId = req.currentUser.id
  const { data, error } = await supabase
    .from('board_posts')
    .delete()
    .eq('id', postId)
    .eq('user_id', userId)
    .select('id')
  if (error) return respondBoardDbError(res, error)
  if (!data?.length) {
    return res.status(404).json({
      error: { message: 'Post not found or you can only delete your own posts.', status: 404 },
    })
  }
  res.status(204).end()
})

app.listen(port, host, async () => {
  console.log(`BoilerIndy backend listening on ${publicBaseUrl}`)
  console.log(`Purdue link mode: ${purdueAuthMode}`)
  console.log(`Database: Supabase`)
  const probe = await supabase.from('board_posts').select('id').limit(1)
  if (probe.error && isBoardSchemaMissingError(probe.error)) {
    console.warn(
      `\n[BoilerIndy] Campus board: table board_posts not found. Run ${BOARD_SQL_FILE} in Supabase SQL Editor, then restart the server.\n`,
    )
  }
})
