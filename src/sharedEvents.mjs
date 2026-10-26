// Shared campus events (issue #30): the pure core of the ingest.
//
// docs/shared-campus-events.md settled the sources: Purdue's events calendar
// (Localist, group "Purdue in Indianapolis"), IU's events calendar (LiveWhale,
// category "IU Indianapolis"), IU Indy athletics' schedule (a calendar file,
// its home games), behind CAMPUS_EVENTS_ENGAGE the Anthology
// Engage event search on BoilerLink and TheSpot, and behind
// CAMPUS_EVENTS_DOWNTOWN the first source beyond campus, White River State
// Park's events calendar (The Events Calendar). This module turns their raw
// JSON listings into rows for campus_events (db/supabase-campus-events.sql):
//
//   - one adapter per platform, each producing the same normalized row;
//   - dedupe_key `<source_key>:<id>`, or the design doc's hash for a row with
//     no id, plus series_key and content_hash;
//   - the Indianapolis filter: the organizer (Engage, through
//     isIndianapolisOrganization), a campus place named in the title or the
//     location, or coordinates within 2.5 km of campus; LiveWhale groups that
//     are not for Purdue students (LIVEWHALE_EXCLUDED_GROUPS) drop as `group`;
//     a downtown source's rows are venue_kind `downtown` (README step 49);
//   - the signals each row carries: free_food (the source's own tag first, then
//     the keyword matcher in src/freeFood.mjs), category, venue_kind and
//     open_to_all, all from rules;
//   - organization_key, the Engage organization that listed the event
//     (`boilerlink:<Id>`, `thespot:<Id>`), which following a club reads
//     (issue #16, db/supabase-club-follows.sql); null for the other sources;
//   - the merge of one source's repeated ids, and the collapse of one event
//     listed twice, by two sources or by one (duplicateReason).
//
// No I/O: src/campusEventsIngest.mjs fetches the pages and writes the rows, and
// docs/campus-events-ingest.md is the operator's view. `classifier` is never
// set here: with CAMPUS_EVENTS_CLASSIFY on, Jev refines the signals afterwards
// (src/campusEventsClassify.mjs, the `classify` option of
// runCampusEventsIngest), which is why the plan also says which rows have free
// food on the source's own word.

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

// The keys of Jev's `category` question (src/campusEventsClassify.mjs), plus
// `deadline` for the official academic dates in Purdue's calendar.
export const CATEGORIES = Object.freeze([
  'career', 'academic', 'social', 'club_business', 'sports_fitness',
  'arts_culture', 'service', 'faith', 'wellness', 'deadline', 'other',
])
// The keys of Jev's `where` question, so its verdict can stand in for the
// rule's answer.
export const VENUE_KINDS = Object.freeze(['indy_campus', 'west_lafayette', 'online', 'elsewhere', 'unknown'])
// Where a downtown source's listings are (issue #30): the museums, the zoo and
// the parks a walk from campus, which are not the campus. A source's own word,
// never one of Jev's answers, so adding it changed none of Jev's questions.
// db/supabase-campus-events-downtown.sql (README step 49) adds it to the
// column's CHECK.
export const DOWNTOWN_VENUE_KIND = 'downtown'

/**
 * Every source the ingest knows, in the order a cross-source duplicate is
 * resolved: the first one listing an event keeps it. `indianapolisScope` means
 * the source's own query is about Indianapolis, so a listing with nothing to
 * place it is taken at the source's word. `downtown` marks a source beyond
 * campus: every listing it keeps is venue_kind `downtown`, and only
 * CAMPUS_EVENTS_DOWNTOWN reads it.
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
  Object.freeze({
    key: 'iu_athletics',
    platform: 'ics',
    label: "IU Indy athletics' schedule (Sidearm calendar file)",
    origin: 'https://iuindyjags.com',
    path: '/calendar.ashx/calendar.ics?sport_id=0',
    days: 60,
    engage: false,
    category: 'sports_fitness',
    // Every game's title names IU Indy wherever it is played, so the location
    // alone places it: "Indianapolis, Ind., James T. Morris Arena" is a home
    // game, "Clarksville, Tenn." an away one, dropped as unplaced.
    placeFromLocation: true,
    indianapolisScope: false,
  }),
  Object.freeze({
    key: 'wrsp_events',
    platform: 'tribe',
    label: "White River State Park's events calendar (The Events Calendar)",
    origin: 'https://whiteriverstatepark.org',
    days: 60,
    engage: false,
    downtown: true,
    // The park's own calendar: a listing with nothing to place it (the Canal
    // Walk has no address) is taken at its word.
    indianapolisScope: true,
  }),
])

/** The keys of the downtown sources, which CAMPUS_EVENTS_DOWNTOWN turns on. */
export const DOWNTOWN_SOURCE_KEYS = Object.freeze(SOURCES.filter((source) => source.downtown).map((source) => source.key))

export function sourceByKey(key) {
  return SOURCES.find((source) => source.key === key) || null
}

export const ENGAGE_SOURCE_KEYS = Object.freeze(SOURCES.filter((source) => source.engage).map((source) => source.key))

/**
 * CAMPUS_EVENTS_ENGAGE to the Engage sources it turns on: `on`, `1`, `true` or
 * `all` for both, a comma list of keys for some (`boilerlink` alone: Purdue's
 * Student Activities and Organizations agreed on 2026-10-18, TheSpot's admins
 * have not been asked), anything else for none. Unknown names are ignored.
 */
export function engageSourcesFromSetting(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (['on', '1', 'true', 'all'].includes(text)) return [...ENGAGE_SOURCE_KEYS]
  const named = new Set(text.split(/[\s,]+/).filter(Boolean))
  return ENGAGE_SOURCE_KEYS.filter((key) => named.has(key))
}

/** The Engage source keys a run reads: `true` for both, a list for some, anything else for none. */
export function enabledEngageSources(engageEnabled) {
  if (engageEnabled === true) return new Set(ENGAGE_SOURCE_KEYS)
  if (Array.isArray(engageEnabled) || engageEnabled instanceof Set) {
    return new Set([...engageEnabled].filter((key) => ENGAGE_SOURCE_KEYS.includes(key)))
  }
  return new Set()
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
//
// Each normalizer keeps the source's own word on free food (its tag, its cost
// field, free entry with food listed) apart from the keyword matcher, which
// reads only the title and description: Jev reads those too, and once it has
// answered it stands in for the matcher, never for the source's word
// (src/campusEventsClassify.mjs).
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
// LiveWhale groups whose listings are not for Purdue students, compared after
// foldText. Counts are of the 647 IU listings in the 31 days from 2026-10-26:
//   - the medical school's calendar: room bookings, exam sittings, grand rounds
//     and research seminars (110), and the cancer center's seminars (3);
//   - Faculty Crossing: development sessions for faculty (15);
//   - Kelley's Executive Education: paid programs for working professionals (27);
//   - staff calendars: Human Resources' benefits webinars (31), financial
//     system training (18), institutional survey support (17), the Center for
//     Teaching and Learning (12), the UITS web team's office hours (5), research
//     administration, compliance and software (17, 2 and 1) and the veterans
//     faculty and staff council (1);
//   - Hands in Autism: a community program's support groups (24);
//   - the Alumni Association: alumni gatherings, most of them in other cities (18);
//   - University College: IU's own withdrawal and refund deadlines, which are not
//     Purdue's, and health program site visits (29);
//   - athletics (10): an away game reads "IU Indy Men's Basketball at Austin
//     Peay" in Clarksville, Tenn., and the team name in the title passes the
//     place rule as campus.
export const LIVEWHALE_EXCLUDED_GROUPS = Object.freeze([
  'iu school of medicine calendar',
  'iu indianapolis faculty crossing events',
  'kelley school of business executive education programs events',
  'indiana university melvin and bren simon comprehensive cancer center events',
  'iu human resources calendar',
  'financial training communications events',
  'institutional survey support events',
  'iu indianapolis center for teaching and learning events',
  'uits web team calendar',
  'iu research events',
  'office for research compliance events calendar',
  'iu research software solutions events',
  'iu indianapolis veterans faculty staff council events',
  'hands in autism events',
  'iu alumni association calendar',
  'iu indianapolis university college events',
  'iu indianapolis athletics events',
])
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

// An Engage organization: `<source_key>:<Id>`, the Id a positive integer as
// Engage numbers them (BoilerLink's event search sends 401442, its
// organizations list "401442"). The CHECK on club_follows.organization_key in
// db/supabase-club-follows.sql repeats this rule.
const ORGANIZATION_KEY_RE = /^(boilerlink|thespot):([1-9][0-9]{0,11})$/

/**
 * campus_events.organization_key for an Engage listing: `<source_key>:<Id>`,
 * or null for a source that is not Engage or an id that is not a positive
 * integer, so one odd listing never stores a key nothing can follow.
 * @param {string} sourceKey
 * @param {unknown} organizationId
 * @returns {string | null}
 */
export function organizationKeyFor(sourceKey, organizationId) {
  if (organizationId == null || typeof organizationId === 'object') return null
  return parseOrganizationKey(`${sourceKey}:${String(organizationId).trim()}`)?.key ?? null
}

/**
 * A club key as a client sends it (GET, PUT and DELETE
 * /api/me/club-follows/:organizationKey) to its parts, or null when it is not
 * one: `boilerlink:401442` is `{ key, sourceKey: 'boilerlink', id: '401442' }`.
 * @param {unknown} value
 * @returns {{ key: string, sourceKey: string, id: string } | null}
 */
export function parseOrganizationKey(value) {
  if (typeof value !== 'string') return null
  const match = ORGANIZATION_KEY_RE.exec(value)
  return match ? { key: value, sourceKey: match[1], id: match[2] } : null
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
 * stores plus the Indianapolis decision and whether the source itself says it
 * has free food (`sourceFreeFood`, which is not a column). Null without a
 * title or a start.
 */
function buildEvent(source, listing) {
  const title = clean(listing.title)
  const startsAt = isoOrNull(listing.startsAt)
  if (!title || !startsAt) return null
  const description = truncate(clean(listing.description), DESCRIPTION_MAX) || null
  const location = clean(listing.location) || null
  const point = coordinates(listing.lat, listing.lon)

  // A source whose titles name the campus wherever the event is (a team's
  // away games) is placed by its location alone.
  const placeText = source.placeFromLocation ? (location ?? '') : `${title} ${location ?? ''}`
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

  const decision = indianapolisDecision({
    org: listing.org === true,
    place,
    near,
    away: westLafayetteText || otherCity,
    hasCoordinates: point != null,
    scope: Boolean(source.indianapolisScope),
  })
  // An excluded group drops a listing the place rules would keep; one they
  // drop already keeps its own reason (far, away).
  const indianapolis = decision.keep && listing.exclude ? { keep: false, by: listing.exclude } : decision
  // What a downtown source keeps is downtown, not on campus, unless it is online.
  if (source.downtown && indianapolis.keep && venueKind !== 'online') venueKind = DOWNTOWN_VENUE_KIND

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
    // On every row, null included: supabase-js writes NULL for a key one row
    // of a batch lacks anyway, and the dry run then shows it too.
    organization_key: listing.organizationKey ?? null,
  }
  return { row, indianapolis, sourceFreeFood: Boolean(listing.sourceFreeFood) }
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
  const sourceFreeFood = event.free === true && FOOD_RE.test(`${title} ${description}`)
  const listing = {
    title,
    description,
    location: [event.location_name || event.location, event.room_number].map(clean).filter(Boolean).join(', '),
    lat: event.geo?.latitude,
    lon: event.geo?.longitude,
    online: event.experience === 'virtual',
    sourceUrl: event.localist_url,
    category: localistCategory(types),
    freeFood: sourceFreeFood || hasFreeFood(title, description),
    sourceFreeFood,
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
  const excluded = LIVEWHALE_EXCLUDED_GROUPS.includes(foldText(clean(raw.group_title)))
  const sourceFreeFood =
    tags.some((tag) => /^free food$/i.test(tag)) ||
    hasFreeFood(cost) ||
    (/^free\b/i.test(cost) && FOOD_RE.test(`${title} ${description} ${tags.join(' ')}`))
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
    freeFood: sourceFreeFood || hasFreeFood(title, description),
    sourceFreeFood,
    openToAll: openToAll(title, audience, LIVEWHALE_OPEN_AUDIENCE_RE),
    seriesGroup: `group:${raw.gid ?? ''}`,
    exclude: excluded ? 'group' : null,
  })
}

/**
 * An Anthology Engage event (`value[]` of /api/discovery/event/search) to a
 * row. `isIndianapolisOrg(raw)` says whether its organization is an
 * Indianapolis one (engageOrgLookup); on TheSpot every organization is. The
 * organization also keys the row's series and gives organization_key, the
 * club a student can follow (organizationKeyFor).
 */
export function normalizeEngageEvent(raw, source, { isIndianapolisOrg = () => false } = {}) {
  if (!raw || typeof raw !== 'object' || !source) return null
  if (raw.visibility && String(raw.visibility).toLowerCase() !== 'public') return null
  if (raw.status && String(raw.status).toLowerCase() !== 'approved') return null
  const id = String(raw.id ?? '').trim()
  const title = clean(raw.name)
  const description = htmlToText(raw.description)
  const sourceFreeFood = toArray(raw.benefitNames).some((name) => /^free food$/i.test(clean(name)))
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
    freeFood: sourceFreeFood || hasFreeFood(title, description),
    sourceFreeFood,
    openToAll: MEMBERS_ONLY_RE.test(title) ? false : null,
    seriesGroup: `org:${raw.organizationId ?? ''}`,
    organizationKey: organizationKeyFor(source.key, raw.organizationId),
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

// ── The Events Calendar (White River State Park) ────────────────────────────

// The park's site sets The Events Calendar's time zone to "UTC+0", and every
// listing's utc_start_date repeats its start_date (a museum opening reads
// 10:00 in both). Its times are the wall clock in Indianapolis, so they are
// read in the campus zone and the "UTC" fields are ignored.
const CAMPUS_TIME_ZONE = 'America/Indiana/Indianapolis'
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
const CAMPUS_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: CAMPUS_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})

// The campus clock minus UTC at an instant: -4 hours in summer, -5 in winter.
function campusOffsetMs(utcMs) {
  const part = Object.fromEntries(CAMPUS_CLOCK.formatToParts(new Date(utcMs)).map(({ type, value }) => [type, value]))
  return Date.UTC(+part.year, +part.month - 1, +part.day, +part.hour, +part.minute, +part.second) - utcMs
}

/**
 * A campus wall-clock time ("2026-10-24 10:00:00", as The Events Calendar
 * writes it) to ISO UTC, on either side of a daylight saving change; null for
 * anything else.
 */
export function campusWallClockToIso(text) {
  const match = WALL_CLOCK_RE.exec(String(text ?? '').trim())
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map((value) => Number(value ?? 0))
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  // The offset at the wall time read as UTC is right except within hours of a
  // change, where the offset at that first answer settles it.
  const first = asUtc - campusOffsetMs(asUtc)
  return new Date(asUtc - campusOffsetMs(first)).toISOString()
}

// The Events Calendar renders the whole event page into `description`: an
// empty date line, the organizer's text with its buttons (RSVP, Buy Tickets),
// then its own blocks (venue, price, the "Add to calendar" links). Only the
// text is the listing's.
const TRIBE_SCHEDULE_RE = /^\s*<div\b[^>]*\bclass="tribe-events-schedule\b[\s\S]*?<\/div>/
const TRIBE_BLOCK_RE = /<div\b[^>]*\bclass="tribe-block\b/
const BUTTONS_RE = /<section\b[^>]*\bclass="wp-block-buttons\b[\s\S]*?<\/section>/g

function tribeText(html) {
  const page = String(html ?? '')
  const blocks = page.search(TRIBE_BLOCK_RE)
  return htmlToText((blocks >= 0 ? page.slice(0, blocks) : page).replace(TRIBE_SCHEDULE_RE, ' ').replace(BUTTONS_RE, ' '))
}

// The park's categories mostly name its attractions. These say what kind of
// event it is, in this order: a charity 5k is service before it is a run, as
// Jev's category question has it. The zoo, the NCAA Hall of Champions and
// "Free Event" (a price) say nothing about the kind.
const TRIBE_CATEGORY = [
  ['charity', 'service'],
  ['run', 'sports_fitness'],
  ['indianapolis indians', 'sports_fitness'],
  ['concert', 'arts_culture'],
  ['imax', 'arts_culture'],
  ['eiteljorg', 'arts_culture'],
  ['indiana state museum', 'arts_culture'],
  ['community event', 'social'],
]

function tribeCategory(names) {
  const folded = new Set(names.map(foldText))
  for (const [name, category] of TRIBE_CATEGORY) {
    if (folded.has(name)) return category
  }
  return null
}

/**
 * A listing of The Events Calendar's REST API (`events[]` of
 * /wp-json/tribe/events/v1/events) to a row: White River State Park's
 * calendar, keyed by the listing's post id, one per occurrence. Its times are
 * campus wall-clock times (campusWallClockToIso). A series is one title at one
 * venue (the two Twilight Tales nights at the Indiana State Museum).
 *
 * Free entry is never free food here, alone or with food in the text: the
 * park's "Free Event" category and a cost of "Free" mean admission, and its
 * listings name food that is sold or collected (the Book Fair's "Sweet treats"
 * from its vendors, the free admission day that raises money for Gleaners
 * Food Bank, both on 2026-10-24). Only the keyword matcher counts, which Jev's
 * answer replaces with CAMPUS_EVENTS_CLASSIFY on. Null for a draft, a listing
 * the site hides from its own lists, or one without a title or a start.
 */
export function normalizeTribeEvent(raw, source = sourceByKey('wrsp_events')) {
  if (!raw || typeof raw !== 'object' || !source) return null
  if (String(raw.status ?? 'publish').toLowerCase() !== 'publish' || raw.hide_from_listings === true) return null
  const venue = raw.venue && typeof raw.venue === 'object' && !Array.isArray(raw.venue) ? raw.venue : {}
  const title = clean(raw.title)
  const description = tribeText(raw.description)
  return buildEvent(source, {
    externalUid: raw.id,
    title,
    description,
    location: [venue.venue, venue.address, venue.city].map(clean).filter(Boolean).join(', '),
    startsAt: campusWallClockToIso(raw.start_date),
    endsAt: campusWallClockToIso(raw.end_date),
    allDay: raw.all_day === true,
    lat: venue.geo_lat,
    lon: venue.geo_lng,
    online: raw.is_virtual === true,
    sourceUrl: raw.url,
    category: tribeCategory(toArray(raw.categories).map((term) => clean(term?.name))),
    freeFood: hasFreeFood(title, description),
    sourceFreeFood: false,
    openToAll: MEMBERS_ONLY_RE.test(title) ? false : null,
    seriesGroup: `venue:${venue.id ?? ''}`,
  })
}

// ── Calendar files (IU Indy athletics) ──────────────────────────────────────

// The result Sidearm puts in front of a game once it is played: "[W] IU Indy
// Volleyball vs Robert Morris" ([W], [L], [T], or [N] for a meet with none).
const ICS_RESULT_RE = /^\s*\[[A-Z]\]\s*/

/**
 * One event of a calendar file, as src/campusEventsIngest.mjs reads it out of
 * the parsed file (icsListings: `uid`, `summary`, `description`, `location`,
 * `url`, `start` and `end` as ISO, `allDay`, `status`), to a row keyed by its
 * UID. The game's result leaves the title, so a played game keeps its row and
 * its content hash; the description drops its first line when that line
 * repeats the title (Sidearm's does), keeping the TV, streaming and ticket
 * lines. The source's own category (`sports_fitness` for athletics). Null for
 * a cancelled event or one without a title or a start.
 */
export function normalizeIcsEvent(raw, source) {
  if (!raw || typeof raw !== 'object' || !source) return null
  if (/^cancell?ed$/i.test(String(raw.status ?? ''))) return null
  const title = clean(String(raw.summary ?? '').replace(ICS_RESULT_RE, ''))
  const lines = String(raw.description ?? '').split(/\r?\n/).map((line) => line.trim())
  if (lines.length && clean(lines[0].replace(ICS_RESULT_RE, '')) === title) lines.shift()
  const description = lines.filter(Boolean).join('\n')
  return buildEvent(source, {
    externalUid: raw.uid,
    title,
    description,
    location: raw.location,
    startsAt: raw.start,
    endsAt: raw.end,
    allDay: raw.allDay === true,
    sourceUrl: decodeEntities(String(raw.url ?? '')),
    category: source.category ?? null,
    freeFood: hasFreeFood(title, description),
    sourceFreeFood: false,
    openToAll: MEMBERS_ONLY_RE.test(title) ? false : null,
    seriesGroup: '',
  })
}

/** One raw listing from a source to its rows (Localist gives one per occurrence). */
export function normalizeListing(source, raw, { isIndianapolisOrg } = {}) {
  if (source.platform === 'localist') return normalizeLocalistEvent(raw, source)
  const built =
    source.platform === 'livewhale'
      ? normalizeLiveWhaleEvent(raw, source)
      : source.platform === 'engage'
        ? normalizeEngageEvent(raw, source, { isIndianapolisOrg })
        : source.platform === 'tribe'
          ? normalizeTribeEvent(raw, source)
          : source.platform === 'ics'
            ? normalizeIcsEvent(raw, source)
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

// ── Duplicates ──────────────────────────────────────────────────────────────
//
// The same event reaches the table under several ids: Purdue Indy Badminton's
// weekly hours are on BoilerLink and TheSpot, PurdueME's graduate school panel
// is "What's Next? A Graduate School Preparation Panel" on Purdue's calendar,
// and Purdue's calendar itself lists one Philharmonic concert at Hilbert Circle
// Theatre twice. duplicateReason decides whether two listings are one event, on
// the start, the title and the place; collapseDuplicates keeps one row per
// event, and the calendar read uses the same rule to leave out a shared row the
// student's own calendar already has (src/campusEventsFeed.mjs).

// Dates and times some sources put in front of a title ("11/2 11:00 AM ...").
const TITLE_DATE_RE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g
const TITLE_TIME_RE = /\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?(?![a-z])/gi
// Words that say nothing about which event a title is.
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'to', 'in', 'on', 'at', 'by', 'from', 'into', 'about',
  's', 'st', 'vs', 'v', 'w', 'presents', 'present', 'featuring', 'feat', 'hosted', 'host',
  'purdue', 'iu', 'indy', 'indianapolis', 'university', 'campus', 'event', 'events',
  'day', 'night', 'session', 'sessions', 'meeting', 'program', 'info', 'information',
])
// Two titles whose meaningful words mostly match: "Grad School Prep Panel"
// shares all four of its words with "What's Next? A Graduate School Preparation
// Panel".
export const SIMILAR_TITLE_SHARE = 0.75

/** The words a title is matched on: folded, without leading dates and times or the words in TITLE_STOPWORDS. */
export function titleWords(title) {
  const text = String(title ?? '').replace(TITLE_DATE_RE, ' ').replace(TITLE_TIME_RE, ' ')
  return [...new Set(foldText(text).split(' ').filter((word) => word && !TITLE_STOPWORDS.has(word)))]
}

// One word is the other, or the start of it with four letters or more:
// grad and graduate, prep and preparation, orchestra and orchestras.
function wordsMatch(a, b) {
  if (a === b) return true
  return Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))
}

/**
 * How two titles compare: `same` when they fold to one text, spaces aside
 * ("RealTalk" and "Real Talk"), `similar` when at least two words and
 * SIMILAR_TITLE_SHARE of the shorter title's words match the other's, else
 * null; `shared` counts the shorter title's words that match.
 */
export function titleMatch(a, b) {
  const foldedA = foldText(a)
  const foldedB = foldText(b)
  if (!foldedA || !foldedB) return { level: null, shared: 0 }
  const wordsA = titleWords(a)
  const wordsB = titleWords(b)
  const [fewer, more] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA]
  const shared = fewer.filter((word) => more.some((other) => wordsMatch(word, other))).length
  if (foldedA === foldedB || foldedA.replaceAll(' ', '') === foldedB.replaceAll(' ', '')) return { level: 'same', shared }
  const similar = shared >= 2 && shared / fewer.length >= SIMILAR_TITLE_SHARE
  return { level: similar ? 'similar' : null, shared }
}

// Course and year numbers tell apart two titles that are otherwise alike
// ("ME 323 Exam Review" and "ME 270 Exam Review" at the same hour).
function numbersConflict(a, b) {
  const numbers = (title) => titleWords(title).filter((word) => /^\d+$/.test(word))
  const numbersA = numbers(a)
  const numbersB = numbers(b)
  return numbersA.length > 0 && numbersB.length > 0 && !numbersA.some((number) => numbersB.includes(number))
}

// A campus room ("ET 002", "SL 165", "ET Atrium") or a campus building code on
// its own (PurdueME's "EL", or "UL" before Lilly Auditorium), as INDY_ROOM_RE
// reads them.
const ROOM_CODE_RE = /\b(ET|SL|IO|CE|PE|EL|LD|CA|UL)\s?(\d{2,4}[A-Z]?|Atrium|ATRIUM)\b/
const BARE_CODE_RE = /^(ET|SL|IO|CE|PE|EL|LD|CA|UL)$/
// Campus buildings by name, which several events share at once.
const CAMPUS_BUILDING_RE =
  /\b(?:campus center|university library|university hall|university tower|cavanaugh hall|taylor hall|inlow hall|hine hall|innovation hall|natatorium|the jungle|boiler park|eskenazi (?:hall|fine art center)|herron|madam walker|walther hall|fesler hall|van ?nuys|michael a\.? carroll|engineering (?:and|&) technology|science and engineering laboratory|purdue student center)\b/i
// A location's parts: split at a comma, a bar, an at sign, or a hyphen or an
// en dash with spaces around it (PurdueME writes the en dash).
const LOCATION_PARTS_RE = new RegExp(`\\s*(?:,|\\||@|\\s[-${String.fromCharCode(0x2013)}]\\s)\\s*`)
// The first part of a location that names no place of its own.
const NO_VENUE_RE = /^(?:indianapolis(?: in(?:diana)?)?|online|virtual|zoom|microsoft teams|teams|webex|google meet|tba|tbd|room \S+|\d+)$/

/**
 * Where a listing is, for telling events apart: a campus `room` ("ET002"), a
 * building `code`, a campus `building` by name, or a named `venue` off those
 * buildings ("hilbert circle theater"; the first part of the location, so
 * "Hilbert Circle Theatre, 45 Monument Circle" agrees). Sources write one
 * building several ways ("ET 103", "Engineering and Technology Building"), so
 * only two answers of the same kind are compared.
 */
export function placeOf(location) {
  const text = String(location ?? '').trim()
  const place = { room: null, code: null, building: null, venue: null }
  if (!text) return place
  const room = ROOM_CODE_RE.exec(text)
  if (room) {
    place.room = `${room[1]}${room[2].toUpperCase()}`
    place.code = room[1]
  }
  const building = CAMPUS_BUILDING_RE.exec(text)
  if (building) place.building = foldText(building[0])
  const first = text.split(LOCATION_PARTS_RE)[0].trim()
  if (BARE_CODE_RE.test(first)) {
    place.code = place.code ?? first
  } else if (!room && !CAMPUS_BUILDING_RE.test(first)) {
    const venue = foldText(first).replace(/\btheatre\b/g, 'theater').replace(/^the /, '')
    if (venue && !NO_VENUE_RE.test(venue)) place.venue = venue
  }
  return place
}

function placesConflict(a, b) {
  return ['room', 'code', 'building', 'venue'].some((kind) => a[kind] && b[kind] && a[kind] !== b[kind])
}

/** One room, or one named venue off campus: never a building shared by many events at once. */
function samePlace(a, b) {
  return Boolean((a.room && a.room === b.room) || (a.venue && a.venue === b.venue))
}

const CAMPUS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })

/** YYYY-MM-DD on the campus calendar, where an all-day listing starts at local midnight. */
export function campusDay(iso) {
  return CAMPUS_DAY.format(new Date(iso))
}

/**
 * Why two listings are one event, or null. Each is `{ title, startsAt, allDay,
 * location, deadline }`. They must start in the same minute, or fall on the
 * same campus day when one of them is all-day (PurdueME's all-day Halloween
 * Crawl and Purdue's 10:00 "CoE Halloween Crawl"). Never one event: a deadline
 * and something else (Purdue's Martin Luther King Jr. Day and the park's free
 * admission that day), two places of one kind that disagree, or titles with
 * different numbers. Then:
 *
 *   - `title`: the same title in the same minute;
 *   - `similar title`: a similar title (titleMatch) in the same minute;
 *   - `day`: the same or a similar title on the all-day's day;
 *   - `place`: the same minute in the same room or named venue, with a word of
 *     the title in common: Hilbert Circle Theater's "A Partners in Music
 *     Education Program Concert" and Purdue's "...Symphony Orchestra Concert".
 *
 * Two listings of one source are one event only by place, and with two words
 * of the title in common (`sameSource`): a source may list two events with one
 * title at once, in different rooms.
 */
export function duplicateReason(a, b, { sameSource = false } = {}) {
  if (Boolean(a.deadline) !== Boolean(b.deadline)) return null
  const sameMinute = String(a.startsAt).slice(0, 16) === String(b.startsAt).slice(0, 16)
  const sameDay = !sameMinute && Boolean(a.allDay || b.allDay) && campusDay(a.startsAt) === campusDay(b.startsAt)
  if (!sameMinute && !sameDay) return null
  const placeA = placeOf(a.location)
  const placeB = placeOf(b.location)
  if (placesConflict(placeA, placeB) || numbersConflict(a.title, b.title)) return null
  const title = titleMatch(a.title, b.title)
  if (sameSource) {
    return sameMinute && samePlace(placeA, placeB) && (title.level === 'same' || title.shared >= 2) ? 'place' : null
  }
  if (title.level === 'same') return sameMinute ? 'title' : 'day'
  if (title.level === 'similar') return sameMinute ? 'similar title' : 'day'
  if (sameMinute && samePlace(placeA, placeB) && title.shared >= 1) return 'place'
  return null
}

/** A campus_events row as duplicateReason reads it. */
export function duplicateView(row) {
  return { title: row.title, startsAt: row.starts_at, allDay: row.all_day, location: row.location, deadline: row.category === 'deadline' }
}

/**
 * One row per event (duplicateReason): the rows of an event collapse into the
 * one from the source listed first in SOURCES, which takes what it lacks from
 * the others. A row joins an event when it is a duplicate of any row already
 * in it, so the third listing of Purdue's concert joins by the copy it
 * resembles. The organization_key it takes keeps a club's event on the list
 * of a student who follows the club when Purdue's calendar lists the same
 * event. `collapsed` says which row each one went into, and why.
 */
export function collapseDuplicates(rows, order = SOURCES.map((source) => source.key)) {
  const rank = (row) => {
    const index = order.indexOf(row.source_key)
    return index < 0 ? order.length : index
  }
  const sorted = [...rows].sort(
    (a, b) => rank(a) - rank(b) || a.starts_at.localeCompare(b.starts_at) || a.dedupe_key.localeCompare(b.dedupe_key),
  )
  // Only rows of one campus day can be one event, so each row is compared
  // within its day.
  const eventsByDay = new Map()
  const events = []
  for (const row of sorted) {
    const day = campusDay(row.starts_at)
    if (!eventsByDay.has(day)) eventsByDay.set(day, [])
    const view = duplicateView(row)
    let joined = false
    for (const event of eventsByDay.get(day)) {
      const why = event.rows
        .map((member) => duplicateReason(duplicateView(member), view, { sameSource: member.source_key === row.source_key }))
        .find(Boolean)
      if (why) {
        event.rows.push(row)
        event.reasons.push(why)
        joined = true
        break
      }
    }
    if (!joined) {
      const event = { rows: [row], reasons: [] }
      eventsByDay.get(day).push(event)
      events.push(event)
    }
  }
  const out = []
  const collapsed = []
  for (const { rows: copies, reasons } of events) {
    let winner = copies[0]
    if (copies.length === 1) {
      out.push(winner)
      continue
    }
    copies.slice(1).forEach((other, index) => {
      collapsed.push({ kept: copies[0].dedupe_key, dropped: other.dedupe_key, title: copies[0].title, why: reasons[index] })
      winner = {
        ...winner,
        description: winner.description ?? other.description,
        ends_at: winner.ends_at ?? other.ends_at,
        location: winner.location ?? other.location,
        category: winner.category ?? other.category,
        free_food: winner.free_food || other.free_food,
        open_to_all: winner.open_to_all ?? other.open_to_all,
        venue_kind: winner.venue_kind === 'unknown' ? other.venue_kind : winner.venue_kind,
        organization_key: winner.organization_key ?? other.organization_key ?? null,
      }
    })
    out.push({ ...winner, content_hash: contentHashFor(winner) })
  }
  return { rows: out, collapsed }
}

// ── The plan ────────────────────────────────────────────────────────────────

const DROPPED_SAMPLE = 50

const count = (tally, key) => {
  tally[key] = (tally[key] || 0) + 1
}

/** What a run reports about its rows: how many, how many with free food, and each venue kind and category. */
export function summarizeRows(rows) {
  const totals = { rows: rows.length, freeFood: 0, venueKinds: {}, categories: {} }
  for (const row of rows) {
    if (row.free_food) totals.freeFood += 1
    count(totals.venueKinds, row.venue_kind)
    count(totals.categories, row.category ?? 'none')
  }
  return totals
}

/**
 * Raw listings per source key in, the rows to upsert out, plus what a dry run
 * reports: per source, how many listings came in, how many rows each
 * Indianapolis signal kept or dropped (keptBy, droppedBy), and the merges; the
 * duplicates collapsed, with the reason for each (collapseDuplicates); a sample
 * of what was dropped and why; totals. Sources absent from
 * `listingsBySource` are skipped. Rows are sorted by start.
 *
 * `sourceFreeFood` is the set of dedupe keys whose free food the source itself
 * states, through merges and collapses (a copy that has it gives it to the row
 * it joins): the classifier keeps those, whatever Jev reads in the text.
 */
export function planCampusEvents(listingsBySource, { isIndianapolisOrg } = {}) {
  const sources = []
  const kept = []
  const dropped = []
  const statedFreeFood = new Set()
  for (const source of SOURCES) {
    if (!Object.prototype.hasOwnProperty.call(listingsBySource || {}, source.key)) continue
    const listings = toArray(listingsBySource[source.key])
    const stats = { key: source.key, listings: listings.length, skipped: 0, keptBy: {}, droppedBy: {}, merged: 0, rows: 0 }
    const sourceRows = []
    for (const raw of listings) {
      const built = normalizeListing(source, raw, { isIndianapolisOrg })
      if (built.length === 0) stats.skipped += 1
      for (const { row, indianapolis, sourceFreeFood } of built) {
        if (indianapolis.keep) {
          count(stats.keptBy, indianapolis.by)
          sourceRows.push(row)
          if (sourceFreeFood) statedFreeFood.add(row.dedupe_key)
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
  const { rows, collapsed } = collapseDuplicates(kept)
  rows.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.dedupe_key.localeCompare(b.dedupe_key))
  for (const { kept: winner, dropped: copy } of collapsed) {
    if (statedFreeFood.has(copy)) statedFreeFood.add(winner)
  }
  const sourceFreeFood = new Set(rows.map((row) => row.dedupe_key).filter((key) => statedFreeFood.has(key)))
  return { rows, sources, collapsed, dropped, totals: summarizeRows(rows), sourceFreeFood }
}
