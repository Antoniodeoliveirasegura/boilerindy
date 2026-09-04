// Live garage availability for Purdue Indianapolis (issue #14).
//
// Purdue Indy parking is run by IU Indianapolis Parking & Transportation, which
// publishes a public, login-free lot-count page for the student (ST) garages:
//   https://v2.aitapps.iu.edu/INPARK_LotCount_V1_Online/IN
// It is server-rendered HTML with no JSON variant and no API key: one
// info-window block per garage plus a Google-Maps marker array carrying lat/lng
// and a fill-level icon. This module is the pure core (HTML in, normalized
// snapshot out) plus a thin fetch shell; server.mjs caches the result.
//
// Quirks of the source, all handled here:
// - "Occupied" can go negative from sensor drift, so occupied is clamped to
//   [0, capacity] and "available" is recomputed from capacity.
// - A garage can omit its counts entirely and carry only an icon-Full marker
//   (seen at 2:46 AM), which is missing data, not a full garage: status is
//   'unknown' and the counts are null.
// - Timestamps are Indianapolis local time with no zone marker.
//
// See docs/parking-status.md for the data contract and the degraded mode.

const DEFAULT_SOURCE_URL = 'https://v2.aitapps.iu.edu/INPARK_LotCount_V1_Online/IN'
const FETCH_TIMEOUT_MS = 10_000
const STALE_AFTER_MS = 30 * 60 * 1000
const FULL_SPACES_LEFT = 10
const TZ = 'America/Indiana/Indianapolis'

export const SOURCE_URL = DEFAULT_SOURCE_URL

/**
 * The six garages an ST (commuter student) permit is valid in, per IU Parking's
 * locations and permits pages (parking.indianapolis.iu.edu). Coordinates are
 * the page's own marker positions, kept here so the map still has pins when
 * the live page is unreachable.
 */
export const GARAGES = [
  { id: 'blackford', name: 'Blackford Garage', code: 'XF', address: '725 W Michigan St', lat: 39.77511025, lng: -86.17058223, type: 'Permit only', stRule: 'All ST spaces' },
  { id: 'barnhill', name: 'Barnhill Garage', code: 'XH', address: '345 Barnhill Dr', lat: 39.772546, lng: -86.178061, type: 'Student permit only', stRule: 'All ST spaces' },
  { id: 'gateway', name: 'Gateway Garage', code: 'XL', address: '525 N Blackford St', lat: 39.775222, lng: -86.16931, type: 'Student permit and visitor', stRule: 'All ST spaces' },
  { id: 'riverwalk', name: 'Riverwalk Garage', code: 'XP', address: '245 University Blvd', lat: 39.77010216, lng: -86.17402427, type: 'Permit and visitor', stRule: 'ST spaces only' },
  { id: 'sports', name: 'Sports Complex Garage', code: 'XD', address: '875 W New York St', lat: 39.77105619, lng: -86.17398426, type: 'Permit and visitor', stRule: 'ST section only' },
  { id: 'lockefield', name: 'Lockefield Garage', code: 'WX', address: '951 Wishard Blvd', lat: 39.77791494, lng: -86.17577506, type: 'Student and visitor', stRule: 'ST section only' },
]

/** Student permit rules, from IU Parking's permits page. Reviewed 2026-09-03. */
export const PERMIT_INFO = {
  reviewedOn: '2026-09-03',
  permits: [
    {
      code: 'ST',
      name: 'ST commuter student permit',
      eligibility: 'Any student not living in a campus housing residence.',
      valid: 'ST and NC surface spaces, plus the student garages: Barnhill, Blackford and Gateway, and the ST sections of Sports, Riverwalk and Lockefield.',
      afterHours: 'Also valid in EM (employee) surface spaces Monday to Friday 4:00 pm to 9:00 am, all day on weekends and university holidays, during fall and spring breaks, and after finals in winter and summer until classes resume.',
    },
    {
      code: 'NCS',
      name: 'NCS north campus student permit',
      eligibility: 'Any student.',
      valid: 'NC surface spaces on Indiana Avenue.',
      afterHours: 'Also valid in ST and EM surface spaces Monday to Friday 4:00 pm to 9:00 am, all day on weekends and university holidays.',
    },
  ],
  links: [
    { label: 'Buy or manage a permit (IU Parking Portal)', href: 'https://parkingiu.t2hosted.com/Account/Portal' },
    { label: 'Permit types and rules', href: 'https://parking.indianapolis.iu.edu/parking/permits/index.html' },
    { label: 'All garages and lots', href: 'https://parking.indianapolis.iu.edu/parking/parking-locations.html' },
    { label: 'IU Parking FAQ for Purdue students', href: 'https://parking.indianapolis.iu.edu/news-events/_news/purduefaqs.html' },
  ],
  notes: [
    'Purdue Indianapolis students buy permits from IU Indianapolis Parking using their IU login.',
    'Counts come from IU Parking garage sensors and can lag or drift. Treat them as a guide, not a guarantee.',
  ],
}

// ── Parsing (pure) ──────────────────────────────────────────────────────────

const BLOCK_RE = /<h1>([^<]+)<\/h1>\s*<h3>([^<]+)<\/h3>([\s\S]*?)<\/p>/g
const TIMESTAMP_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
}

function pickInt(body, label) {
  const m = new RegExp(label + ':\\s*<b>\\s*(-?\\d+)\\s*<\\/b>', 'i').exec(body)
  return m ? Number(m[1]) : null
}

function pickText(body, label) {
  const m = new RegExp(label + ':\\s*(?:<b>)?\\s*([^<]+?)\\s*(?:<\\/b>)?\\s*<br', 'i').exec(body)
  return m ? decodeEntities(m[1]).trim() : null
}

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** First word of the page name is the stable key: "Lockefield Student Garage" -> "lockefield". */
function idFor(name) {
  return normalizeName(name).split(' ')[0] || 'garage'
}

const toNumber = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null)

/** The page embeds `markers:[{...}]` (valid JSON) inside a jQuery call. */
export function parseMarkers(html) {
  const text = String(html || '')
  const start = text.indexOf('markers:[')
  if (start < 0) return []
  const from = start + 'markers:'.length
  let depth = 0
  for (let k = from; k < text.length; k++) {
    const ch = text[k]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(from, k + 1))
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      }
    }
  }
  return []
}

/** Raw per-garage rows exactly as the page states them (no normalization). */
export function parseLotCountHtml(html) {
  const text = String(html || '')
  const markerByName = new Map(parseMarkers(text).map((m) => [normalizeName(m?.title), m]))
  const rows = []
  for (const m of text.matchAll(BLOCK_RE)) {
    const name = decodeEntities(m[1]).trim()
    const address = decodeEntities(m[2]).trim()
    const body = m[3]
    const marker = markerByName.get(normalizeName(name))
    const iconMatch = marker?.icon?.path ? /(icon-[A-Za-z0-9]+)\.png/i.exec(String(marker.icon.path)) : null
    rows.push({
      name,
      address,
      rates: pickText(body, 'Rates'),
      capacity: pickInt(body, 'Capacity'),
      occupied: pickInt(body, 'Occupied'),
      available: pickInt(body, 'Available'),
      timestampText: pickText(body, 'Timestamp'),
      lat: toNumber(marker?.lat),
      lng: toNumber(marker?.lng),
      icon: iconMatch ? iconMatch[1] : null,
    })
  }
  return rows
}

// ── Time ────────────────────────────────────────────────────────────────────

function tzOffsetMs(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const o = {}
  for (const p of parts) o[p.type] = p.value
  const asUtc = Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour), Number(o.minute), Number(o.second))
  return asUtc - date.getTime()
}

/** "9/4/2026 2:46:41 AM" (Indianapolis local) -> ISO-8601 UTC, or null. */
export function indyLocalToIso(text) {
  const m = TIMESTAMP_RE.exec(String(text || '').trim())
  if (!m) return null
  let hour = Number(m[4]) % 12
  if (/pm/i.test(m[7])) hour += 12
  const localAsUtc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]), Number(m[6] || 0))
  // Two passes so the offset is taken at the right instant across DST changes.
  let utc = localAsUtc - tzOffsetMs(new Date(localAsUtc))
  utc = localAsUtc - tzOffsetMs(new Date(utc))
  return new Date(utc).toISOString()
}

// ── Normalization ───────────────────────────────────────────────────────────

/** 'open' | 'busy' | 'full' | 'unknown', from clamped counts. */
export function classifyGarage({ capacity, occupied }) {
  if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(occupied)) return 'unknown'
  const available = capacity - occupied
  const pct = (occupied / capacity) * 100
  if (available <= FULL_SPACES_LEFT || pct >= 90) return 'full'
  if (pct >= 70) return 'busy'
  return 'open'
}

function normalizeGarage(row, now) {
  const stat = GARAGES.find((g) => g.id === idFor(row.name))
  const capacity = Number.isFinite(row.capacity) && row.capacity > 0 ? row.capacity : null
  let occupied = null
  let available = null
  let percentFull = null
  if (capacity && Number.isFinite(row.occupied)) {
    occupied = Math.min(capacity, Math.max(0, row.occupied))
    available = capacity - occupied
    percentFull = Math.round((occupied / capacity) * 100)
  }
  const updatedAt = indyLocalToIso(row.timestampText)
  const stale = updatedAt ? now.getTime() - Date.parse(updatedAt) > STALE_AFTER_MS : true
  return {
    id: stat?.id || idFor(row.name),
    name: stat?.name || row.name,
    sourceName: row.name,
    code: stat?.code || null,
    address: row.address || stat?.address || null,
    type: stat?.type || null,
    stRule: stat?.stRule || null,
    lat: row.lat ?? stat?.lat ?? null,
    lng: row.lng ?? stat?.lng ?? null,
    capacity,
    occupied,
    available,
    percentFull,
    status: classifyGarage({ capacity, occupied }),
    icon: row.icon,
    updatedAt,
    stale,
  }
}

const STATUS_RANK = { open: 0, busy: 0, full: 0, unknown: 1 }

function compareGarages(a, b) {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
  if (rank !== 0) return rank
  const avail = (b.available ?? -1) - (a.available ?? -1)
  if (avail !== 0) return avail
  return a.name.localeCompare(b.name)
}

function staticGarage(g) {
  return {
    id: g.id,
    name: g.name,
    sourceName: null,
    code: g.code,
    address: g.address,
    type: g.type,
    stRule: g.stRule,
    lat: g.lat,
    lng: g.lng,
    capacity: null,
    occupied: null,
    available: null,
    percentFull: null,
    status: 'unknown',
    icon: null,
    updatedAt: null,
    stale: true,
  }
}

/** What the API serves when the live page is unreachable or unparseable. */
export function degradedSnapshot(error, now = new Date()) {
  return {
    ok: false,
    error: String(error),
    source: 'iu-parking-lotcount',
    sourceUrl: DEFAULT_SOURCE_URL,
    fetchedAt: now.toISOString(),
    garages: GARAGES.map(staticGarage),
    permits: PERMIT_INFO,
  }
}

/** HTML in, normalized snapshot out. Never throws. */
export function buildSnapshot(html, { now = new Date() } = {}) {
  const rows = parseLotCountHtml(html)
  if (rows.length === 0) return degradedSnapshot('no-garages', now)
  const garages = rows.map((row) => normalizeGarage(row, now)).sort(compareGarages)
  return {
    ok: true,
    source: 'iu-parking-lotcount',
    sourceUrl: DEFAULT_SOURCE_URL,
    fetchedAt: now.toISOString(),
    garages,
    permits: PERMIT_INFO,
  }
}

// ── Fetch shell ─────────────────────────────────────────────────────────────

export async function fetchParkingStatus({
  fetchImpl = globalThis.fetch,
  url = process.env.PARKING_STATUS_URL || DEFAULT_SOURCE_URL,
  now = new Date(),
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'BoilerIndy/1.0 (+https://www.boilerindy.app)', accept: 'text/html' },
    })
    if (!res.ok) return degradedSnapshot(`http-${res.status}`, now)
    const html = await res.text()
    return buildSnapshot(html, { now })
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : String(error?.message || error)
    return degradedSnapshot(reason, now)
  } finally {
    clearTimeout(timer)
  }
}
