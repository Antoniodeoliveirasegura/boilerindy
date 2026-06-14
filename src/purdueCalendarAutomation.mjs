import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const jobs = new Map()
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 8
const DEFAULT_START_URL =
  process.env.PURDUE_UNITIME_PERSONAL_SCHEDULE_URL ||
  'https://timetable.mypurdue.purdue.edu/Timetabling/personal'

/** UniTime often exposes the feed as /Timetabling/export?... (token in query). */
const PURDUE_EXPORT_URL_RE =
  /https:\/\/timetable\.mypurdue\.purdue\.edu\/Timetabling\/[^\s"'<>]+/gi

export function isCalendarAutomationEnabled() {
  const v = (process.env.PURDUE_CALENDAR_AUTOMATION || '1').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

function nowIso() {
  return new Date().toISOString()
}

function buildJobPayload(job) {
  if (!job) return null
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    icsUrl: job.icsUrl || null,
    error: job.error || null,
  }
}

function setJobState(job, status, message, extra = {}) {
  job.status = status
  job.message = message
  job.updatedAt = nowIso()
  Object.assign(job, extra)
}

async function closeJobBrowser(job) {
  try {
    await job.page?.context()?.close?.()
  } catch {}

  try {
    await job.browser?.close?.()
  } catch {}
}

async function clickIfVisible(locator) {
  try {
    const candidate = locator.first()
    if (await candidate.isVisible({ timeout: 500 })) {
      await candidate.click({ timeout: 1500 })
      return true
    }
  } catch {}
  return false
}

async function tryOpenExportFlow(page) {
  // Prefer an exact "Export" control so we do not accidentally hit "Export iCalendar" first.
  const exportOpened =
    (await clickIfVisible(page.getByRole('button', { name: /^export$/i }))) ||
    (await clickIfVisible(page.getByText(/^export$/i))) ||
    (await clickIfVisible(page.getByRole('button', { name: /export/i })))

  if (exportOpened) {
    await page.waitForTimeout(400)
  }

  await clickIfVisible(page.getByRole('menuitem', { name: /export icalendar/i })) ||
    (await clickIfVisible(page.getByRole('button', { name: /export icalendar/i }))) ||
    (await clickIfVisible(page.getByText(/export icalendar/i)))
}

function normalizeCandidateUrl(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed.startsWith('http')) return null
  if (!/ical|ics|Timetabling|timetable\.mypurdue/i.test(trimmed)) return null
  return trimmed
}

function extractPurdueExportFromText(text) {
  const s = String(text || '')
  PURDUE_EXPORT_URL_RE.lastIndex = 0
  let m
  while ((m = PURDUE_EXPORT_URL_RE.exec(s)) !== null) {
    const candidate = normalizeCandidateUrl(m[0])
    if (candidate) return candidate
  }
  return null
}

async function extractIcsUrl(page) {
  const inputValues = await page.locator('input, textarea').evaluateAll((elements) =>
    elements
      .map((element) => ('value' in element ? element.value : ''))
      .filter(Boolean),
  )

  for (const value of inputValues) {
    const fromField = extractPurdueExportFromText(value) || normalizeCandidateUrl(value)
    if (fromField) return fromField
  }

  const hrefs = await page.locator('a').evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute('href') || '')
      .filter(Boolean),
  )

  for (const href of hrefs) {
    const fromHref = extractPurdueExportFromText(href) || normalizeCandidateUrl(href)
    if (fromHref) return fromHref
  }

  const bodyText = await page.locator('body').innerText().catch(() => '')
  const fromBody = extractPurdueExportFromText(bodyText)
  if (fromBody) return fromBody

  const generic = bodyText.match(/https:\/\/[^\s"'<>]+/i)
  return normalizeCandidateUrl(generic?.[0] || '')
}

function findChromiumExecutable() {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  if (envPath && fs.existsSync(envPath)) return envPath

  const browsersCachePath = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')

  if (!fs.existsSync(browsersCachePath)) return null

  const chromiumDirs = fs.readdirSync(browsersCachePath)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse()

  for (const dir of chromiumDirs) {
    const base = path.join(browsersCachePath, dir)
    const candidates = [
      path.join(base, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(base, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(base, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(base, 'chrome-linux', 'chrome'),
      path.join(base, 'chrome-win', 'chrome.exe'),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
  }
  return null
}

async function runCalendarCapture(job) {
  try {
    setJobState(job, 'launching', 'Opening Purdue timetable in a local browser...')
    let chromium
    try {
      ;({ chromium } = await import('playwright'))
    } catch (e) {
      throw new Error(
        'Playwright is not available. From the project root run: npx playwright install chromium',
      )
    }

    const launchOptions = { headless: false }
    const resolvedExec = findChromiumExecutable()
    if (resolvedExec) {
      launchOptions.executablePath = resolvedExec
    }

    try {
      job.browser = await chromium.launch(launchOptions)
    } catch (e) {
      const msg = e?.message || String(e)
      throw new Error(
        msg.includes('Executable doesn') || msg.includes('browser')
          ? `Chromium not found. Run: npx playwright install chromium (from outside Cursor sandbox / in a regular terminal)`
          : msg,
      )
    }
    const context = await job.browser.newContext()
    job.page = await context.newPage()

    await job.page.goto(DEFAULT_START_URL, { waitUntil: 'domcontentloaded' })
    await job.page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {})
    setJobState(job, 'awaiting_login', 'Finish Purdue login and Duo in the opened browser. The app will capture your iCalendar URL automatically.')

    const deadline = Date.now() + DEFAULT_TIMEOUT_MS
    while (Date.now() < deadline) {
      await tryOpenExportFlow(job.page)
      const foundUrl = await extractIcsUrl(job.page)
      if (foundUrl) {
        setJobState(job, 'ready', 'iCalendar URL captured. Connecting your schedule now...', { icsUrl: foundUrl })
        await closeJobBrowser(job)
        return
      }

      if (job.page.isClosed()) {
        throw new Error('The Purdue timetable browser was closed before the iCalendar URL could be captured.')
      }

      setJobState(job, 'awaiting_export', 'Open Personal Schedule, then Export → Export iCalendar. The app is watching for the URL.')
      await job.page.waitForTimeout(1500)
    }

    throw new Error('Timed out waiting for the Purdue timetable iCalendar URL. Try again and keep the export dialog open.')
  } catch (error) {
    setJobState(job, 'error', error.message || 'Could not capture the Purdue timetable URL.', {
      error: error.message || 'Could not capture the Purdue timetable URL.',
    })
    await closeJobBrowser(job)
  }
}

export function getCalendarCaptureJob(userId) {
  return buildJobPayload(jobs.get(userId))
}

export async function startCalendarCapture(userId) {
  if (!isCalendarAutomationEnabled()) {
    throw new Error('Purdue calendar automation is disabled on this server (PURDUE_CALENDAR_AUTOMATION).')
  }
  const existing = jobs.get(userId)
  if (existing && ['launching', 'awaiting_login', 'awaiting_export'].includes(existing.status)) {
    return buildJobPayload(existing)
  }

  const job = {
    id: crypto.randomUUID(),
    userId,
    status: 'queued',
    message: 'Preparing Purdue timetable automation...',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    icsUrl: null,
    error: null,
    browser: null,
    page: null,
  }

  jobs.set(userId, job)
  void runCalendarCapture(job)
  return buildJobPayload(job)
}

export async function cancelCalendarCapture(userId) {
  const job = jobs.get(userId)
  if (!job) return null
  setJobState(job, 'cancelled', 'Calendar capture cancelled by user.')
  await closeJobBrowser(job)
  return buildJobPayload(job)
}
