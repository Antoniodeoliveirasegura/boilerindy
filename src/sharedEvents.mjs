// Shared campus events (issue #30): the pure core of the ingest.
//
// docs/shared-campus-events.md settled the sources: Purdue's events calendar
// (Localist, group "Purdue in Indianapolis"), IU's events calendar (LiveWhale,
// category "IU Indianapolis") and, behind CAMPUS_EVENTS_ENGAGE, the Anthology
// Engage event search on BoilerLink and TheSpot. This module turns their raw
// JSON listings into rows for campus_events (db/supabase-campus-events.sql):
//
//   - one adapter per platform, each producing the same normalized row;
//   - dedupe_key `<source_key>:<id>`, or the design doc's hash for a row with
//     no id, plus series_key and content_hash;
//   - the Indianapolis filter: the organizer (Engage, through
//     isIndianapolisOrganization), a campus place named in the title or the
//     location, or coordinates within 2.5 km of campus;
//   - the signals each row carries: free_food (the source's own tag first, then
//     the keyword matcher in src/freeFood.mjs), category, venue_kind and
//     open_to_all, all from rules;
//   - the merge of one source's repeated ids, and the collapse of the same event
//     listed by two sources.
//
// No I/O: src/campusEventsIngest.mjs fetches the pages and writes the rows, and
// docs/campus-events-ingest.md is the operator's view. Jev is not wired (there
// is no TypeSafe key yet), so `classifier` stays NULL here; the hook is the
// `classify` option of runCampusEventsIngest.

import { createHash } from 'node:crypto'
import { decodeEntities, foldText, htmlToText, isIndianapolisOrganization, truncate } from './boilerlinkClubs.mjs'
import { hasFreeFood } from './freeFood.mjs'

// The shared downtown campus (Purdue Indianapolis and IU Indianapolis).
export const CAMPUS = Object.freeze({ lat: 39.774, lon: -86.1765 })
export const NEAR_CAMPUS_KM = 2.5
const WEST_LAFAYETTE = Object.freeze({ lat: 40.4237, lon: -86.9212 })
const WEST_LAFAYETTE_KM = 10
// Descriptions are stored as plain text, cut at a word past this length.
export const DESCRIPTION_MAX = 4000
const DAY_MS = 24 * 60 * 60 * 1000

// The keys of the planned Jev `category` question (docs/campus-events-ingest.md),
// plus `deadline` for the official academic dates in Purdue's calendar.
export const CATEGORIES = Object.freeze([
  'career', 'academic', 'social', 'club_business', 'sports_fitness',
  'arts_culture', 'service', 'faith', 'wellness', 'deadline', 'other',
])
// The keys of the planned Jev `where` question, so its verdict can replace the
// rule's answer.
export const VENUE_KINDS = Object.freeze(['indy_campus', 'west_lafayette', 'online', 'elsewhere', 'unknown'])

/**
 * Every source the ingest knows, in the order a cross-source duplicate is
 * resolved: the first one listing an event keeps it. `indianapolisScope` means
 * the source's own query is about Indianapolis, so a listing with nothing to
 * place it is taken at the source's word.
 */
export const SOURCES = Object.freeze([
  Object.freeze({
    key: 'purdue_events',
    platform: 'localist',
    label: "Purdue's events calendar (Localist)",
    origin: 'https://events.purdue.edu',
    groupId: '46197580344207', // "Purdue in Indianapolis"
    days: 120,
    engage: false,
    indianapolisScope: true,
  }),
  Object.freeze({
    key: 'iu_events',
    platform: 'livewhale',
    label: "IU's events calendar (LiveWhale)",
    origin: 'https://events.iu.edu',
    category: 'IU Indianapolis',
    nearMiles: 1,
    days: 31,
    engage: false,
    indianapolisScope: true,
  }),
  Object.freeze({
    key: 'boilerlink',
    platform: 'engage',
    label: 'BoilerLink (Anthology Engage)',
    origin: 'https://boilerlink.purdue.edu',
    engage: true,
    // Every Purdue campus: the organizer, the place or the coordinates must
    // say Indianapolis.
    indianapolisScope: false,
    everyOrgIsIndianapolis: false,
  }),
  Object.freeze({
    key: 'thespot',
    platform: 'engage',
    label: 'TheSpot (Anthology Engage)',
    origin: 'https://thespot.indianapolis.iu.edu',
    engage: true,
    // IU Indianapolis's own Engage instance: every organization on it is an
    // Indianapolis one.
    indianapolisScope: true,
    everyOrgIsIndianapolis: true,
  }),
])

export function sourceByKey(key) {
  return SOURCES.find((source) => source.key === key) || null
}

// ── Places ──────────────────────────────────────────────────────────────────

// Rooms on the shared campus as the sources write them: a building code with a
// room number or "Atrium" ("ET 103", "IO 102", "ET329", "EL Atrium").
// Case-sensitive, so "et" or "pe" inside ordinary words never counts.
const INDY_ROOM_RE = /\b(?:ET|SL|IO|CE|PE|EL|LD|CA|UL)\s?(?:\d{2,4}[A-Z]?|Atrium|ATRIUM)\b/
// Buildings and landmarks of the shared campus, and the city itself.
const INDY_PLACE_RE =
  /\b(?:indianapolis|downtown indy|iu indy|iui|iupui|campus center|university library|university hall|cavanaugh hall|taylor hall|inlow hall|hine hall|innovation hall|natatorium|the jungle|boiler park|eskenazi|herron|madam walker|walther hall|fesler hall|van ?nuys|michael a\.? carroll|engineering (?:and|&) technology|purdue student center)\b/i
// Read in the location only: a title like "Watch party for the West Lafayette
// game" says nothing about where the party is.
const WEST_LAFAYETTE_RE =
  /\b(?:west lafayette|walc|purdue memorial union|pmu|corec|recwell|mackey arena|ross-ade|elliott hall|stewart center|lawson|beering hall)\b/i
const OTHER_CITY_RE =
  /\b(?:fort wayne|bloomington|terre haute|evansville|south bend|muncie|kokomo|carmel|fishers|chicago|dayton|cincinnati|louisville)\b/i
const ONLINE_PLACE_RE = /^(?:online|virtual|zoom|microsoft teams|teams|webex|google meet)\b/i
const ONLINE_TITLE_RE = /\b(?:online only|virtual only|webinar)\b/i

function coordinates(lat, lon) {
  if (lat == null || lon == null || lat === '' || lon === '') return null
  const la = Number(lat)
  const lo = Number(lon)
  if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return null
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null
  return { lat: la, lon: lo }
}

/** Distance in km, equirectangular: plenty for "within a few km of campus". */
export function kmBetween(a, b) {
  const dy = (a.lat - b.lat) * 111.0
  const dx = (a.lon - b.lon) * 111.0 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180))
  return Math.hypot(dx, dy)
}

/** km from the campus, or null when the coordinates are missing or unusable. */
export function kmFromCampus(lat, lon) {
  const point = coordinates(lat, lon)
  return point ? kmBetween(point, CAMPUS) : null
}

/**
 * Whether a listing is an Indianapolis campus event, and the signal that
 * decided it. In order: a campus place in the title or location, coordinates
 * within 2.5 km, another campus or city named in the location (drops it, even
 * for an Indianapolis organizer's away game), an Indianapolis organizer, and
 * last the source's own scope for a listing with no coordinates at all.
 * Engage coordinates are often wrong (TheSpot puts University Hall in Texas),
 * so far-away coordinates never outvote the organizer.
 */
export function indianapolisDecision({ org = false, place = false, near = false, away = false, hasCoordinates = false, scope = false }) {
  if (place) return { keep: true, by: 'place' }
  if (near) return { keep: true, by: 'near' }
  if (away) return { keep: false, by: 'away' }
  if (org) return { keep: true, by: 'org' }
  if (scope && !hasCoordinates) return { keep: true, by: 'scope' }
  return { keep: false, by: hasCoordinates ? 'far' : 'unplaced' }
}

// ── Signals ─────────────────────────────────────────────────────────────────

// Members-only sessions: practices, rehearsals, officer and committee meetings,
// tryouts. "Practice Your POMO" is an open study session, hence the lookahead.
const MEMBERS_ONLY_RE =
  /\b(?:practice(?!\s+your\b)|practices|rehearsals?|officers? (?:meeting|check[- ]in|training)|e-?board meeting|executive board meeting|committee meeting|members[- ]only|tryouts?|invitation[- ]only|invite[- ]only)\b/i

// Food in the listing, for sources whose own flag says only that entry is
// free: Localist's `free` and a LiveWhale cost of "Free" mean free admission
// (Purdue's hockey games carry it), so they count as free food only together
// with food in the listing ("the first 90 students eat free").
const FOOD_RE =
  /\b(?:food|foods|eat|meal|meals|lunch|dinner|breakfast|brunch|snacks?|pizza|coffee|donuts?|doughnuts?|bagels?|cookies?|treats?|candy|boba|ice cream|s'mores|popcorn|refreshments|drinks|beverages|cider|cupcakes?|tacos?|entrees?|catered|catering)\b/i

const LOCALIST_TYPE_CATEGORY = new Map([
  ['athletics', 'sports_fitness'],
  ['concert/performance', 'arts_culture'],
  ['lecture/talk', 'academic'],
  ['seminar/colloquium', 'academic'],
  ['workshop/training', 'academic'],
  ['social/networking event', 'social'],
])
// LiveWhale lists event types alphabetically, so the first one is not the main
// one: this order decides instead.
const LIVEWHALE_TYPE_CATEGORY = [
  ['sporting events', 'sports_fitness'],
  ['art and museum exhibitions', 'arts_culture'],
  ['performances, shows, and films', 'arts_culture'],
  ['lectures, talks, seminars, and conferences', 'academic'],
  ['training, non-credit classes, and learning opportunities', 'academic'],
  ['career development', 'career'],
  ['health and wellness', 'wellness'],
  ['culture and languages', 'arts_culture'],
  ['functions, festivals, and celebrations', 'social'],
]
const LIVEWHALE_FITNESS_TAG_RE = /^(?:fitness|fitness classes|group fitness classes)$/i
const ENGAGE_THEME_CATEGORY = new Map([
  ['social', 'social'],
  ['athletics', 'sports_fitness'],
  ['thoughtfullearning', 'academic'],
  ['arts', 'arts_culture'],
  ['cultural', 'arts_culture'],
  ['communityservice', 'service'],
  ['fundraising', 'service'],
  ['spirituality', 'faith'],
  ['groupbusiness', 'club_business'],
])
// Audiences that open an event to any student.
const LOCALIST_OPEN_AUDIENCE_RE = /^(?:general public|students\b)/i
const LIVEWHALE_OPEN_AUDIENCE_RE = /^(?:students|the public)$/i

function localistCategory(types) {
  const names = types.map((name) => name.toLowerCase())
  if (names.includes('dates and deadlines')) return 'deadline'
  for (const name of names) {
    const category = LOCALIST_TYPE_CATEGORY.get(name)
    if (category) return category
  }
  return null
}

function liveWhaleCategory(types, tags) {
  if (tags.some((tag) => LIVEWHALE_FITNESS_TAG_RE.test(tag))) return 'sports_fitness'
  const names = new Set(types.map((name) => name.toLowerCase()))
  for (const [type, category] of LIVEWHALE_TYPE_CATEGORY) {
    if (names.has(type)) return category
  }
  return null
}

function engageCategory(theme) {
  return ENGAGE_THEME_CATEGORY.get(String(theme ?? '').toLowerCase()) ?? null
}

/** false for a members-only session, true when the audience is open, else null. */
function openToAll(title, audience, openAudienceRe) {
  if (MEMBERS_ONLY_RE.test(title)) return false
  if (audience.some((name) => openAudienceRe.test(name))) return true
  return null
}

// ── Keys ────────────────────────────────────────────────────────────────────

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * `<source_key>:<id>` when the feed gives an id; otherwise the design doc's
 * hash of the trimmed, lowercased title, the start (ISO, UTC) and the trimmed,
 * lowercased location. The description and the end are left out on purpose:
 * an edited blurb or an added end time updates the row instead of forking it.
 */
export function dedupeKeyFor(sourceKey, externalUid, { title, startsAt, location }) {
  const id = String(externalUid ?? '').trim()
  if (id) return `${sourceKey}:${id}`
  const lower = (value) => String(value ?? '').trim().toLowerCase()
  return sha256Hex(`${lower(title)}|${startsAt}|${lower(location)}`)
}

/** sha256 of the text a classifier reads: title, description and location. */
export function contentHashFor({ title, description, location }) {
  return sha256Hex(JSON.stringify([title ?? '', description ?? '', location ?? '']))
}

/** Shared by the occurrences of one recurring listing from one organizer or group. */
export function seriesKeyFor(sourceKey, group, title) {
  return `${sourceKey}:${sha256Hex(`${group}|${foldText(title)}`).slice(0, 16)}`
}

// ── Normalization ───────────────────────────────────────────────────────────

const clean = (value) => decodeEntities(String(value ?? '')).replace(/\s+/g, ' ').trim()
const toArray = (value) => (Array.isArray(value) ? value : [])

function isoOrNull(value) {
  if (value == null || value === '') return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** The URL when it is http(s), else null; the read path (src/campusEventsFeed.mjs) checks links with it too. */
export function httpUrlOrNull(value) {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * One listing, already read out of its platform's shape, to the row the table
 * stores plus the Indianapolis decision. Null without a title or a start.
 */
function buildEvent(source, listing) {
  const title = clean(listing.title)
  const startsAt = isoOrNull(listing.startsAt)
  if (!title || !startsAt) return null
  const description = truncate(clean(listing.description), DESCRIPTION_MAX) || null
  const location = clean(listing.location) || null
  const point = coordinates(listing.lat, listing.lon)

  const placeText = `${title} ${location ?? ''}`
  const place = INDY_ROOM_RE.test(placeText) || INDY_PLACE_RE.test(placeText)
  const near = point != null && kmBetween(point, CAMPUS) <= NEAR_CAMPUS_KM
  const westLafayetteText = Boolean(location && WEST_LAFAYETTE_RE.test(location))
  const otherCity = Boolean(location && OTHER_CITY_RE.test(location))
  const westLafayette = westLafayetteText || (point != null && kmBetween(point, WEST_LAFAYETTE) <= WEST_LAFAYETTE_KM)
  const online = Boolean(listing.online) || ONLINE_TITLE_RE.test(title) || Boolean(location && ONLINE_PLACE_RE.test(location))

  let venueKind = 'unknown'
  if (online) venueKind = 'online'
  else if (place || near) venueKind = 'indy_campus'
  else if (westLafayette) venueKind = 'west_lafayette'
  else if (otherCity || point) venueKind = 'elsewhere'

  const indianapolis = indianapolisDecision({
    org: listing.org === true,
    place,
    near,
    away: westLafayetteText || otherCity,
    hasCoordinates: point != null,
    scope: Boolean(source.indianapolisScope),
  })

  const externalUid = String(listing.externalUid ?? '').trim() || null
  const row = {
    title,
    description,
    starts_at: startsAt,
    ends_at: isoOrNull(listing.endsAt),
    location,
    all_day: Boolean(listing.allDay),
    source_key: source.key,
    source_url: httpUrlOrNull(listing.sourceUrl),
    external_uid: externalUid,
    dedupe_key: dedupeKeyFor(source.key, externalUid, { title, startsAt, location }),
    category: listing.category ?? null,
    free_food: Boolean(listing.freeFood),
    venue_kind: venueKind,
    open_to_all: listing.openToAll ?? null,
    series_key: seriesKeyFor(source.key, listing.seriesGroup ?? '', title),
    content_hash: contentHashFor({ title, description, location }),
  }
  return { row, indianapolis }
}

/**
 * A Localist event (`events[].event` of /api/2/events) to one row per
 * occurrence (`event_instances`). With `distinct=true` that is the next one.
 * Private and cancelled events give none.
 */
export function normalizeLocalistEvent(event, source = sourceByKey('purdue_events')) {
  if (!event || typeof event !== 'object' || event.private === true) return []
  if (/^cancell?ed$/i.test(String(event.status ?? ''))) return []
  const types = toArray(event.filters?.event_types).map((type) => clean(type?.name)).filter(Boolean)
  const audience = toArray(event.filters?.event_audience).map((type) => clean(type?.name)).filter(Boolean)
  const title = clean(event.title)
  const description = clean(event.description_text)
  const listing = {
    title,
    description,
    location: [event.location_name || event.location, event.room_number].map(clean).filter(Boolean).join(', '),
    lat: event.geo?.latitude,
    lon: event.geo?.longitude,
    online: event.experience === 'virtual',
    sourceUrl: event.localist_url,
    category: localistCategory(types),
    freeFood: (event.free === true && FOOD_RE.test(`${title} ${description}`)) || hasFreeFood(title, description),
    openToAll: openToAll(title, audience, LOCALIST_OPEN_AUDIENCE_RE),
    seriesGroup: `event:${event.id ?? ''}`,
  }
  const out = []
  for (const wrapper of toArray(event.event_instances)) {
    const instance = wrapper?.event_instance
    if (!instance) continue
    const built = buildEvent(source, {
      ...listing,
      externalUid: instance.id,
      startsAt: instance.start,
      endsAt: instance.end,
      allDay: instance.all_day === true,
    })
    if (built) out.push(built)
  }
  return out
}

/**
 * A LiveWhale event (`data[]` of /live/json/events) to a row. A multi-day
 * event comes once per day with the same id; mergeRepeatedIds joins them.
 */
export function normalizeLiveWhaleEvent(raw, source = sourceByKey('iu_events')) {
  if (!raw || typeof raw !== 'object' || raw.is_canceled) return null
  const title = clean(raw.title)
  const description = htmlToText(raw.summary)
  const tags = toArray(raw.tags).map(clean).filter(Boolean)
  const types = toArray(raw.event_types).map(clean).filter(Boolean)
  const audience = toArray(raw.event_types_audience).map(clean).filter(Boolean)
  const cost = htmlToText(raw.cost)
  const location = clean(raw.location || raw.location_title)
  const freeFood =
    tags.some((tag) => /^free food$/i.test(tag)) ||
    hasFreeFood(cost) ||
    (/^free\b/i.test(cost) && FOOD_RE.test(`${title} ${description} ${tags.join(' ')}`)) ||
    hasFreeFood(title, description)
  return buildEvent(source, {
    externalUid: raw.id,
    title,
    description,
    location,
    startsAt: raw.date_iso,
    endsAt: raw.date2_iso,
    allDay: Boolean(raw.is_all_day),
    lat: raw.location_latitude,
    lon: raw.location_longitude,
    // "Hybrid" events have a room; only an online-only one is online.
    online: Boolean(raw.is_online) && (/online only/i.test(String(raw.online_type ?? '')) || !location),
    sourceUrl: raw.url,
    category: liveWhaleCategory(types, tags),
    freeFood,
    openToAll: openToAll(title, audience, LIVEWHALE_OPEN_AUDIENCE_RE),
    seriesGroup: `group:${raw.gid ?? ''}`,
  })
}

/**
 * An Anthology Engage event (`value[]` of /api/discovery/event/search) to a
 * row. `isIndianapolisOrg(raw)` says whether its organization is an
 * Indianapolis one (engageOrgLookup); on TheSpot every organization is.
 */
export function normalizeEngageEvent(raw, source, { isIndianapolisOrg = () => false } = {}) {
  if (!raw || typeof raw !== 'object' || !source) return null
  if (raw.visibility && String(raw.visibility).toLowerCase() !== 'public') return null
  if (raw.status && String(raw.status).toLowerCase() !== 'approved') return null
  const id = String(raw.id ?? '').trim()
  const title = clean(raw.name)
  const description = htmlToText(raw.description)
  return buildEvent(source, {
    externalUid: id,
    title,
    description,
    location: raw.location,
    startsAt: raw.startsOn,
    endsAt: raw.endsOn,
    allDay: false,
    lat: raw.latitude,
    lon: raw.longitude,
    sourceUrl: id ? `${source.origin}/event/${encodeURIComponent(id)}` : null,
    category: engageCategory(raw.theme),
    freeFood: toArray(raw.benefitNames).some((name) => /^free food$/i.test(clean(name))) || hasFreeFood(title, description),
    openToAll: MEMBERS_ONLY_RE.test(title) ? false : null,
    seriesGroup: `org:${raw.organizationId ?? ''}`,
    org: source.everyOrgIsIndianapolis ? true : Boolean(isIndianapolisOrg(raw)),
  })
}

/**
 * Whether an Engage event's organization is an Indianapolis one: the club
 * directory's flag (src/boilerlinkClubs.mjs, which reads the organization's
 * description too) when it lists the organization, else
 * isIndianapolisOrganization on the name alone.
 */
export function engageOrgLookup(clubs) {
  const byId = new Map()
  for (const club of toArray(clubs)) {
    if (club?.id != null) byId.set(String(club.id), Boolean(club.indianapolis))
  }
  return (raw) => {
    const known = byId.get(String(raw?.organizationId ?? ''))
    if (known !== undefined) return known
    return isIndianapolisOrganization({ name: raw?.organizationName })
  }
}

/** One raw listing from a source to its rows (Localist gives one per occurrence). */
export function normalizeListing(source, raw, { isIndianapolisOrg } = {}) {
  if (source.platform === 'localist') return normalizeLocalistEvent(raw, source)
  const built =
    source.platform === 'livewhale'
      ? normalizeLiveWhaleEvent(raw, source)
      : source.platform === 'engage'
        ? normalizeEngageEvent(raw, source, { isIndianapolisOrg })
        : null
  return built ? [built] : []
}

// ── Dedupe ──────────────────────────────────────────────────────────────────

function endOf(row) {
  if (row.ends_at) return row.ends_at
  return row.all_day ? new Date(Date.parse(row.starts_at) + DAY_MS).toISOString() : null
}

/**
 * Rows of one source that share a dedupe_key become one: LiveWhale repeats a
 * multi-day event's id on every day it runs. The merged row starts with the
 * first day listed and ends with the last, and has free food when any copy does.
 */
export function mergeRepeatedIds(rows) {
  const byKey = new Map()
  let merged = 0
  for (const row of rows) {
    const seen = byKey.get(row.dedupe_key)
    if (!seen) {
      byKey.set(row.dedupe_key, row)
      continue
    }
    merged += 1
    const first = row.starts_at < seen.starts_at ? row : seen
    const ends = [endOf(seen), endOf(row)].filter(Boolean).sort()
    byKey.set(row.dedupe_key, { ...first, ends_at: ends.at(-1) ?? null, free_food: seen.free_food || row.free_food })
  }
  return { rows: [...byKey.values()], merged }
}

/**
 * The same event listed by two sources has two ids and so two dedupe keys
 * (Purdue Indy Badminton's weekly hours are on BoilerLink and TheSpot). Rows of
 * different sources with the same folded title and start minute collapse into
 * the one from the source listed first in SOURCES, which takes what it lacks
 * from the others. Rows of the same source are never collapsed here.
 */
export function collapseCrossSource(rows, order = SOURCES.map((source) => source.key)) {
  const rank = (row) => {
    const index = order.indexOf(row.source_key)
    return index < 0 ? order.length : index
  }
  const groups = new Map()
  for (const row of rows) {
    const key = `${foldText(row.title)}|${row.starts_at.slice(0, 16)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const out = []
  const collapsed = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0])
      continue
    }
    const sorted = [...group].sort((a, b) => rank(a) - rank(b))
    let winner = sorted[0]
    for (const other of sorted.slice(1)) {
      if (other.source_key === winner.source_key) {
        out.push(other)
        continue
      }
      collapsed.push({ kept: winner.dedupe_key, dropped: other.dedupe_key, title: winner.title })
      winner = {
        ...winner,
        description: winner.description ?? other.description,
        ends_at: winner.ends_at ?? other.ends_at,
        location: winner.location ?? other.location,
        category: winner.category ?? other.category,
        free_food: winner.free_food || other.free_food,
        open_to_all: winner.open_to_all ?? other.open_to_all,
        venue_kind: winner.venue_kind === 'unknown' ? other.venue_kind : winner.venue_kind,
      }
    }
    out.push({ ...winner, content_hash: contentHashFor(winner) })
  }
  return { rows: out, collapsed }
}

// ── The plan ────────────────────────────────────────────────────────────────

const DROPPED_SAMPLE = 50

const count = (tally, key) => {
  tally[key] = (tally[key] || 0) + 1
}

/**
 * Raw listings per source key in, the rows to upsert out, plus what a dry run
 * reports: per source, how many listings came in, how many rows each
 * Indianapolis signal kept or dropped (keptBy, droppedBy), and the merges; the cross-source
 * collapses; a sample of what was dropped and why; totals. Sources absent from
 * `listingsBySource` are skipped. Rows are sorted by start.
 */
export function planCampusEvents(listingsBySource, { isIndianapolisOrg } = {}) {
  const sources = []
  const kept = []
  const dropped = []
  for (const source of SOURCES) {
    if (!Object.prototype.hasOwnProperty.call(listingsBySource || {}, source.key)) continue
    const listings = toArray(listingsBySource[source.key])
    const stats = { key: source.key, listings: listings.length, skipped: 0, keptBy: {}, droppedBy: {}, merged: 0, rows: 0 }
    const sourceRows = []
    for (const raw of listings) {
      const built = normalizeListing(source, raw, { isIndianapolisOrg })
      if (built.length === 0) stats.skipped += 1
      for (const { row, indianapolis } of built) {
        if (indianapolis.keep) {
          count(stats.keptBy, indianapolis.by)
          sourceRows.push(row)
        } else {
          count(stats.droppedBy, indianapolis.by)
          if (dropped.length < DROPPED_SAMPLE) {
            dropped.push({ source_key: row.source_key, title: row.title, starts_at: row.starts_at, location: row.location, why: indianapolis.by })
          }
        }
      }
    }
    const merged = mergeRepeatedIds(sourceRows)
    stats.merged = merged.merged
    stats.rows = merged.rows.length
    kept.push(...merged.rows)
    sources.push(stats)
  }
  const { rows, collapsed } = collapseCrossSource(kept)
  rows.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.dedupe_key.localeCompare(b.dedupe_key))
  const totals = { rows: rows.length, freeFood: 0, venueKinds: {}, categories: {} }
  for (const row of rows) {
    if (row.free_food) totals.freeFood += 1
    count(totals.venueKinds, row.venue_kind)
    count(totals.categories, row.category ?? 'none')
  }
  return { rows, sources, collapsed, dropped, totals }
}
