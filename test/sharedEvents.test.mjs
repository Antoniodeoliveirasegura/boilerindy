// Tests for the shared campus events core (issue #30). Pure: raw listings in,
// campus_events rows out. The fixtures are real listings from the live check of
// 2026-10-17 (docs/shared-campus-events.md), trimmed to the fields the adapters
// read, with organizers' contact addresses replaced by contact@example.edu:
//
//   campus-events-localist.json   Purdue's events calendar, group "Purdue in Indianapolis"
//   campus-events-livewhale.json  IU's events calendar: eleven rows of the "IU Indianapolis"
//                                 query within a mile of campus, and three rows tagged
//                                 "Free food" from the same category without the distance filter
//   campus-events-boilerlink.json BoilerLink's event search
//   campus-events-thespot.json    TheSpot's event search
//
// The club directory flags below are what the live directory said about these
// organizations on 2026-10-17.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  CAMPUS,
  CATEGORIES,
  NEAR_CAMPUS_KM,
  SOURCES,
  VENUE_KINDS,
  collapseCrossSource,
  contentHashFor,
  dedupeKeyFor,
  engageOrgLookup,
  indianapolisDecision,
  kmFromCampus,
  mergeRepeatedIds,
  normalizeEngageEvent,
  normalizeListing,
  normalizeLiveWhaleEvent,
  normalizeLocalistEvent,
  planCampusEvents,
  seriesKeyFor,
  sourceByKey,
} from '../src/sharedEvents.mjs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const LOCALIST = fixture('campus-events-localist.json').events.map((wrapper) => wrapper.event)
const LIVEWHALE = fixture('campus-events-livewhale.json').data
const BOILERLINK = fixture('campus-events-boilerlink.json').value
const THESPOT = fixture('campus-events-thespot.json').value

const PURDUE = sourceByKey('purdue_events')
const IU = sourceByKey('iu_events')
const BOILERLINK_SOURCE = sourceByKey('boilerlink')
const THESPOT_SOURCE = sourceByKey('thespot')

const CLUBS = [
  { id: '407268', indianapolis: true }, // LCMS-U of Purdue University-Indianapolis Chapter
  { id: '383441', indianapolis: true }, // SHPE at Purdue University in Indianapolis
  { id: '24070', indianapolis: false }, // Purdue Student Union Board
  { id: '398688', indianapolis: true }, // Club Volleyball at Purdue in Indianapolis
  { id: '398920', indianapolis: true }, // Computer Science Women's Network (Indianapolis)
  { id: '401442', indianapolis: true }, // Taekwondo Club of Purdue Indianapolis
  { id: '400129', indianapolis: true }, // Purdue Badminton Club Indianapolis
  { id: '24658', indianapolis: false }, // Purdue Mechanical Engineering Ambassadors
  { id: '420527', indianapolis: true }, // Indy Climbing Club
  { id: '405441', indianapolis: true }, // Boiler Grand Prix (Indianapolis)
  { id: '70546', indianapolis: false }, // Purdue Lunabotics
]
const isIndianapolisOrg = engageOrgLookup(CLUBS)

const COLUMNS = [
  'title', 'description', 'starts_at', 'ends_at', 'location', 'all_day',
  'source_key', 'source_url', 'external_uid', 'dedupe_key',
  'category', 'free_food', 'venue_kind', 'open_to_all', 'series_key', 'content_hash',
].sort()

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const localist = (id) => LOCALIST.find((event) => event.id === id)
const liveWhale = (id) => LIVEWHALE.filter((row) => row.id === id)
const engage = (rows, id) => rows.find((row) => row.id === id)
const one = (built) => {
  assert.equal(built.length, 1)
  return built[0]
}

// ── Purdue's events calendar (Localist) ─────────────────────────────────────

test('a Localist occurrence becomes a row keyed by its instance id, in UTC, with the room in the location', () => {
  const { row, indianapolis } = one(normalizeLocalistEvent(localist(54099974347398), PURDUE))
  assert.deepEqual(indianapolis, { keep: true, by: 'place' })
  assert.deepEqual(Object.keys(row).sort(), COLUMNS)
  assert.equal(row.title, 'Leadership Experience at Purdue (LEAP) Retreat')
  assert.equal(row.starts_at, '2026-10-17T14:00:00.000Z')
  assert.equal(row.ends_at, '2026-10-17T19:00:00.000Z')
  assert.equal(row.all_day, false)
  assert.equal(row.location, 'Engineering, Science and Technology Building - Purdue Indianapolis, 327')
  assert.equal(row.source_key, 'purdue_events')
  assert.equal(row.source_url, 'https://events.purdue.edu/event/leadership-experience-at-purdue-leap-retreat')
  assert.equal(row.external_uid, '54099974349447')
  assert.equal(row.dedupe_key, 'purdue_events:54099974349447')
  assert.equal(row.category, 'academic') // Workshop/training
  assert.equal(row.venue_kind, 'indy_campus')
  assert.equal(row.open_to_all, true) // audience: Students (undergraduate)
  assert.equal(row.free_food, false)
  assert.match(row.content_hash, /^[0-9a-f]{64}$/)
  assert.match(row.series_key, /^purdue_events:[0-9a-f]{16}$/)
  assert.ok(row.description.startsWith('The LEAP Retreat is a one-time, half-day workshop'))
  assert.ok(!/\n/.test(row.description))
})

test("Localist's `free` means free entry: hockey games stay off free food, a food truck where students eat free counts", () => {
  const hockey = one(normalizeLocalistEvent(localist(54036713356057), PURDUE)).row
  assert.equal(localist(54036713356057).free, true)
  assert.equal(hockey.free_food, false)
  const fuelUp = one(normalizeLocalistEvent(localist(54231361790350), PURDUE)).row
  assert.equal(fuelUp.free_food, true)
  assert.equal(fuelUp.venue_kind, 'indy_campus') // Boiler Park - Indianapolis
  // Free coffee with no `free` flag and none of the matcher's words: a known
  // miss the source text alone cannot close (docs/campus-events-ingest.md).
  assert.equal(one(normalizeLocalistEvent(localist(54258454489048), PURDUE)).row.free_food, false)
})

test('the Purdue in Indianapolis group is filtered by place: West Lafayette and far-off venues drop, unplaced listings stay', () => {
  const decide = (id) => {
    const { row, indianapolis } = one(normalizeLocalistEvent(localist(id), PURDUE))
    return [indianapolis.keep, indianapolis.by, row.venue_kind]
  }
  assert.deepEqual(decide(53734181400051), [false, 'away', 'west_lafayette']) // Guy J. Mackey Arena
  assert.deepEqual(decide(54036713356057), [false, 'far', 'elsewhere']) // State Fairgrounds, 5.6 km
  assert.deepEqual(decide(54064756154516), [false, 'far', 'elsewhere']) // Carmel, 21 km
  assert.deepEqual(decide(54221764418376), [true, 'scope', 'online']) // virtual, no place
  assert.deepEqual(decide(53488984667410), [true, 'scope', 'unknown']) // PSUB: no place at all
  assert.deepEqual(decide(54258454489048), [true, 'place', 'indy_campus']) // "ET Atrium - 1st Floor", no coordinates
  assert.deepEqual(decide(54045913664029), [true, 'place', 'indy_campus']) // room codes only: EL 101, ET 215
  assert.deepEqual(decide(53728270164669), [true, 'place', 'indy_campus']) // Westin Indianapolis
})

test('official dates are deadlines, all day, and kept without a place', () => {
  const { row, indianapolis } = one(normalizeLocalistEvent(localist(52735943778575), PURDUE))
  assert.deepEqual(indianapolis, { keep: true, by: 'scope' })
  assert.equal(row.title, 'Thanksgiving Vacation')
  assert.equal(row.category, 'deadline')
  assert.equal(row.all_day, true)
  assert.equal(row.starts_at, '2026-11-25T05:00:00.000Z')
  assert.equal(row.ends_at, null)
  assert.equal(row.location, null)
})

test('each Localist occurrence is its own row in one series; private and cancelled events give none', () => {
  const event = localist(53877355225963) // The Founder's Table, every Wednesday
  const twoWeeks = {
    ...event,
    event_instances: [
      ...event.event_instances,
      { event_instance: { ...event.event_instances[0].event_instance, id: 53877355231090, start: '2026-10-28T10:00:00-04:00', end: '2026-10-28T11:00:00-04:00' } },
    ],
  }
  const rows = normalizeLocalistEvent(twoWeeks, PURDUE).map((built) => built.row)
  assert.deepEqual(rows.map((row) => row.dedupe_key), ['purdue_events:53877355231089', 'purdue_events:53877355231090'])
  assert.equal(rows[0].series_key, rows[1].series_key)
  assert.equal(rows[0].content_hash, rows[1].content_hash)
  assert.deepEqual(normalizeLocalistEvent({ ...event, private: true }, PURDUE), [])
  assert.deepEqual(normalizeLocalistEvent({ ...event, status: 'canceled' }, PURDUE), [])
  assert.deepEqual(normalizeLocalistEvent({ ...event, event_instances: [] }, PURDUE), [])
  assert.deepEqual(normalizeLocalistEvent({ ...event, title: '  ' }, PURDUE), [])
})

// ── IU's events calendar (LiveWhale) ────────────────────────────────────────

test('a LiveWhale exhibit listed once a day merges into one row spanning the days', () => {
  const days = liveWhale(2429402)
  assert.equal(days.length, 3)
  const built = days.map((raw) => normalizeLiveWhaleEvent(raw, IU))
  assert.ok(built.every(({ indianapolis }) => indianapolis.keep))
  const { rows, merged } = mergeRepeatedIds(built.map(({ row }) => row))
  assert.equal(merged, 2)
  assert.equal(rows.length, 1)
  const [exhibit] = rows
  assert.equal(exhibit.title, 'Andrew Winship: ÆNIGMATA')
  assert.equal(exhibit.dedupe_key, 'iu_events:2429402')
  assert.equal(exhibit.all_day, true)
  assert.equal(exhibit.starts_at, '2026-10-17T04:00:00.000Z')
  assert.equal(exhibit.ends_at, '2026-10-20T04:00:00.000Z') // the end of Oct 19, campus time
  assert.equal(exhibit.category, 'arts_culture')
  assert.equal(exhibit.open_to_all, true) // audience: Students, The public
  assert.equal(exhibit.free_food, false) // cost "Free" is entry, and nothing to eat
  assert.equal(exhibit.source_url, 'https://events.iu.edu/herron/event/2429402-andrew-winship-anigmata')
})

test('LiveWhale text is decoded, fitness classes are sports, and occurrences of a class share a series', () => {
  const seafloor = one(normalizeListing(IU, liveWhale(2325999)[0])).row
  assert.equal(seafloor.location, 'SIDNEY & LOIS ESKENAZI HALL')
  assert.equal(seafloor.open_to_all, null) // audience: Faculty, Staff
  const [early, late] = [2394594, 2394620].map((id) => normalizeLiveWhaleEvent(liveWhale(id)[0], IU).row)
  assert.equal(early.title, 'Yoga')
  assert.equal(early.category, 'sports_fitness') // tags: Fitness classes
  assert.equal(early.free_food, false) // "Free with Campus Recreation membership."
  assert.notEqual(early.dedupe_key, late.dedupe_key)
  assert.equal(early.series_key, late.series_key)
  assert.equal(early.series_key, seriesKeyFor('iu_events', 'group:24', 'Yoga'))
})

test('LiveWhale free food comes from its tag; Terre Haute and Fort Wayne drop; online only and hybrid are told apart', () => {
  const library = normalizeLiveWhaleEvent(liveWhale(2440319)[0], IU)
  assert.equal(library.row.free_food, true) // tag "Free food"
  assert.deepEqual(library.indianapolis, { keep: true, by: 'place' }) // UNIVERSITY LIBRARY
  const golf = normalizeLiveWhaleEvent(liveWhale(2433047)[0], IU)
  assert.equal(golf.row.free_food, true)
  assert.deepEqual(golf.indianapolis, { keep: false, by: 'away' })
  assert.equal(golf.row.venue_kind, 'elsewhere')
  const fortWayne = normalizeLiveWhaleEvent(liveWhale(2447894)[0], IU)
  assert.deepEqual(fortWayne.indianapolis, { keep: false, by: 'away' })
  assert.equal(fortWayne.row.venue_kind, 'online') // "Online only"
  assert.equal(normalizeLiveWhaleEvent(liveWhale(2385038)[0], IU).row.venue_kind, 'online') // "Scholarly Writing - ONLINE ONLY"
  assert.equal(normalizeLiveWhaleEvent(liveWhale(2138351)[0], IU).row.venue_kind, 'indy_campus') // Hybrid, VanNuys
  assert.equal(normalizeLiveWhaleEvent(liveWhale(2427999)[0], IU).row.category, 'academic') // a graduate school fair
  assert.equal(normalizeLiveWhaleEvent(liveWhale(2434217)[0], IU).row.ends_at, null)
  assert.equal(normalizeLiveWhaleEvent({ ...liveWhale(2434217)[0], is_canceled: 1 }, IU), null)
})

// ── Anthology Engage (BoilerLink, TheSpot) ──────────────────────────────────

test('BoilerLink events are kept by an Indianapolis organizer, a campus place or 2.5 km, and dropped otherwise', () => {
  const decide = (id) => {
    const built = normalizeEngageEvent(engage(BOILERLINK, id), BOILERLINK_SOURCE, { isIndianapolisOrg })
    return [built.indianapolis.keep, built.indianapolis.by, built.row.venue_kind]
  }
  assert.deepEqual(decide('12768937'), [true, 'place', 'indy_campus']) // Bible Study, Campus Center
  assert.deepEqual(decide('12772604'), [true, 'place', 'indy_campus']) // PSUB, not an Indy org, at Boiler Park
  assert.deepEqual(decide('12749493'), [true, 'near', 'indy_campus']) // Lux on Capitol, 1.3 km
  assert.deepEqual(decide('12891899'), [true, 'org', 'elsewhere']) // Club Volleyball at Wright State, 180 km
  assert.deepEqual(decide('12525117'), [true, 'org', 'online']) // CS Women's Network, Online
  assert.deepEqual(decide('12838338'), [true, 'org', 'elsewhere']) // Indy Climbing Club, 3.8 km
  assert.deepEqual(decide('12840846'), [false, 'far', 'west_lafayette']) // ME Fun Run, West Lafayette coordinates
  assert.deepEqual(decide('12448649'), [false, 'away', 'west_lafayette']) // WALC 1018
  assert.deepEqual(decide('12837747'), [false, 'away', 'west_lafayette']) // Purdue Memorial Union
})

test('an Engage row links its event page and carries the Free Food benefit, the theme and members-only sessions', () => {
  const shpe = normalizeEngageEvent(engage(BOILERLINK, '12884656'), BOILERLINK_SOURCE, { isIndianapolisOrg }).row
  assert.deepEqual(Object.keys(shpe).sort(), COLUMNS)
  assert.equal(shpe.source_url, 'https://boilerlink.purdue.edu/event/12884656')
  assert.equal(shpe.dedupe_key, 'boilerlink:12884656')
  assert.equal(shpe.free_food, true)
  assert.equal(shpe.category, 'club_business') // theme GroupBusiness
  assert.equal(shpe.starts_at, '2026-10-19T21:30:00.000Z')
  assert.ok(shpe.description && !/<[a-z]/i.test(shpe.description))
  const practice = normalizeEngageEvent(engage(BOILERLINK, '12593108'), BOILERLINK_SOURCE, { isIndianapolisOrg }).row
  assert.equal(practice.open_to_all, false)
  assert.equal(practice.category, 'sports_fitness')
  const hidden = normalizeEngageEvent({ ...engage(BOILERLINK, '12884656'), visibility: 'Private' }, BOILERLINK_SOURCE)
  assert.equal(hidden, null)
  assert.equal(normalizeEngageEvent({ ...engage(BOILERLINK, '12884656'), status: 'Pending' }, BOILERLINK_SOURCE), null)
})

test('engageOrgLookup trusts the club directory, then the organization name alone', () => {
  assert.equal(isIndianapolisOrg({ organizationId: 398688, organizationName: 'anything' }), true)
  // In the directory but not an Indianapolis org, whatever the event says.
  assert.equal(isIndianapolisOrg({ organizationId: 24070, organizationName: 'Purdue Student Union Board' }), false)
  // Not in the directory (an empty directory after an outage, say): the name decides.
  const nameOnly = engageOrgLookup([])
  assert.equal(nameOnly({ organizationId: 398688, organizationName: 'Club Volleyball at Purdue in Indianapolis' }), true)
  assert.equal(nameOnly({ organizationId: 24183, organizationName: 'Purdue Squash Club' }), false)
})

test('on TheSpot every organization is an Indianapolis one, and wrong coordinates do not move a campus place', () => {
  const built = (id) => normalizeEngageEvent(engage(THESPOT, id), THESPOT_SOURCE)
  // University Hall with coordinates in Texas, Carroll Stadium with coordinates in Illinois.
  assert.deepEqual(built('12818733').indianapolis, { keep: true, by: 'place' })
  assert.equal(built('12818733').row.venue_kind, 'indy_campus')
  assert.equal(built('12818733').row.free_food, true)
  assert.deepEqual(built('12515641').indianapolis, { keep: true, by: 'place' })
  assert.equal(built('12515641').row.venue_kind, 'indy_campus')
  assert.equal(built('12807359').row.venue_kind, 'indy_campus') // "Downtown Indy"
  assert.equal(built('12865995').row.free_food, false) // a Chipotle fundraiser sells the food
  assert.equal(built('12865995').row.category, 'service')
  assert.equal(built('12827272').row.open_to_all, false) // Club Tennis Practice
  assert.equal(built('12827272').row.source_url, 'https://thespot.indianapolis.iu.edu/event/12827272')
  // An org signal would keep an unplaced TheSpot event; nothing else here has to.
  const unplaced = normalizeEngageEvent({ ...engage(THESPOT, '12827272'), location: 'Somewhere TBD' }, THESPOT_SOURCE)
  assert.deepEqual(unplaced.indianapolis, { keep: true, by: 'org' })
})

// ── Rules and keys ──────────────────────────────────────────────────────────

test('indianapolisDecision: place, then 2.5 km, then another city named, then the organizer, then the scope', () => {
  assert.deepEqual(indianapolisDecision({ place: true, away: true }), { keep: true, by: 'place' })
  assert.deepEqual(indianapolisDecision({ near: true, away: true, hasCoordinates: true }), { keep: true, by: 'near' })
  assert.deepEqual(indianapolisDecision({ away: true, org: true }), { keep: false, by: 'away' })
  assert.deepEqual(indianapolisDecision({ org: true, hasCoordinates: true }), { keep: true, by: 'org' })
  assert.deepEqual(indianapolisDecision({ scope: true }), { keep: true, by: 'scope' })
  assert.deepEqual(indianapolisDecision({ scope: true, hasCoordinates: true }), { keep: false, by: 'far' })
  assert.deepEqual(indianapolisDecision({}), { keep: false, by: 'unplaced' })
  assert.equal(kmFromCampus(CAMPUS.lat, CAMPUS.lon), 0)
  assert.ok(kmFromCampus('39.773892', '-86.17') < NEAR_CAMPUS_KM)
  assert.equal(kmFromCampus(null, null), null)
  assert.equal(kmFromCampus('0', '0'), null)
})

test('members-only sessions read as closed, an open study session does not', () => {
  const openness = (title) => normalizeEngageEvent({ ...engage(BOILERLINK, '12768937'), name: title }, BOILERLINK_SOURCE).row.open_to_all
  for (const title of ['Fall 2026 practices part 2', 'Music Club Fall Rehearsals.', 'Officer Check In - Indianapolis', 'Club Tennis Practice', 'Tryouts', 'Members only mixer']) {
    assert.equal(openness(title), false, title)
  }
  for (const title of ['Practice Your POMO', 'Bible Study', 'Meet the Officers social']) {
    assert.equal(openness(title), null, title)
  }
})

test('dedupe_key is source:id, or the design doc hash, which ignores the description and the end', () => {
  assert.equal(dedupeKeyFor('boilerlink', 12884656, {}), 'boilerlink:12884656')
  const startsAt = '2026-10-23T22:00:00.000Z'
  const expected = sha256(`career fair|${startsAt}|campus center`)
  assert.equal(dedupeKeyFor('purdue_events', '', { title: '  Career Fair ', startsAt, location: ' Campus Center' }), expected)
  const raw = { ...engage(BOILERLINK, '12768937'), id: '' }
  const a = normalizeEngageEvent(raw, BOILERLINK_SOURCE).row
  const b = normalizeEngageEvent({ ...raw, description: '<p>Edited blurb</p>', endsOn: '2026-10-20T19:00:00+00:00' }, BOILERLINK_SOURCE).row
  assert.equal(a.external_uid, null)
  assert.equal(a.source_url, null)
  assert.equal(a.dedupe_key, b.dedupe_key)
  assert.notEqual(a.content_hash, b.content_hash)
  assert.equal(a.content_hash, contentHashFor({ title: a.title, description: a.description, location: a.location }))
})

test('a link that is not http(s) is not stored', () => {
  const raw = { ...localist(54099974347398), localist_url: 'javascript:alert(1)' }
  assert.equal(one(normalizeLocalistEvent(raw, PURDUE)).row.source_url, null)
})

test('the same event on two sources collapses into the first source; one source never collapses with itself', () => {
  const badminton = normalizeEngageEvent(engage(BOILERLINK, '12728673'), BOILERLINK_SOURCE, { isIndianapolisOrg }).row
  const crossPost = normalizeEngageEvent(engage(THESPOT, '12728562'), THESPOT_SOURCE).row
  assert.equal(badminton.starts_at, crossPost.starts_at)
  const { rows, collapsed } = collapseCrossSource([crossPost, badminton])
  assert.deepEqual(rows.map((row) => row.dedupe_key), ['boilerlink:12728673'])
  assert.deepEqual(collapsed, [{ kept: 'boilerlink:12728673', dropped: 'thespot:12728562', title: 'Weekly Badminton Club Hours' }])
  const twin = { ...badminton, dedupe_key: 'boilerlink:1', external_uid: '1' }
  assert.equal(collapseCrossSource([badminton, twin]).rows.length, 2)
  // A row that lacks something takes it from the copy it absorbs.
  const merged = collapseCrossSource([{ ...badminton, category: null, free_food: false }, { ...crossPost, category: 'social', free_food: true }]).rows[0]
  assert.equal(merged.category, 'social')
  assert.equal(merged.free_food, true)
})

// ── The plan ────────────────────────────────────────────────────────────────

test('planCampusEvents over every fixture: per-source counts, one collapse, valid unique rows sorted by start', () => {
  const plan = planCampusEvents(
    { purdue_events: LOCALIST, iu_events: LIVEWHALE, boilerlink: BOILERLINK, thespot: THESPOT },
    { isIndianapolisOrg },
  )
  assert.deepEqual(plan.sources, [
    { key: 'purdue_events', listings: 12, skipped: 0, keptBy: { place: 6, scope: 3 }, droppedBy: { far: 2, away: 1 }, merged: 0, rows: 9 },
    { key: 'iu_events', listings: 14, skipped: 0, keptBy: { place: 12 }, droppedBy: { away: 2 }, merged: 2, rows: 10 },
    { key: 'boilerlink', listings: 12, skipped: 0, keptBy: { place: 5, org: 3, near: 1 }, droppedBy: { far: 1, away: 2 }, merged: 0, rows: 9 },
    { key: 'thespot', listings: 6, skipped: 0, keptBy: { place: 5, near: 1 }, droppedBy: {}, merged: 0, rows: 6 },
  ])
  assert.equal(plan.collapsed.length, 1)
  assert.equal(plan.rows.length, 9 + 10 + 9 + 6 - 1)
  assert.equal(plan.totals.rows, plan.rows.length)
  assert.equal(plan.totals.freeFood, 5)
  assert.deepEqual(plan.totals.venueKinds, { indy_campus: 26, elsewhere: 2, online: 3, unknown: 2 })
  assert.equal(plan.dropped.length, 8)
  assert.ok(plan.dropped.every((d) => ['far', 'away', 'unplaced'].includes(d.why)))

  const keys = plan.rows.map((row) => row.dedupe_key)
  assert.equal(new Set(keys).size, keys.length)
  const starts = plan.rows.map((row) => row.starts_at)
  assert.deepEqual(starts, [...starts].sort())
  for (const row of plan.rows) {
    assert.deepEqual(Object.keys(row).sort(), COLUMNS)
    assert.ok(VENUE_KINDS.includes(row.venue_kind), row.venue_kind)
    assert.ok(row.category === null || CATEGORIES.includes(row.category), row.category)
    assert.ok([true, false, null].includes(row.open_to_all))
  }
  // Only the sources handed in are planned.
  assert.deepEqual(planCampusEvents({ purdue_events: LOCALIST }).sources.map((s) => s.key), ['purdue_events'])
})

test('the vocabularies and columns match db/supabase-campus-events.sql', () => {
  const sql = readFileSync(new URL('../db/supabase-campus-events.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '')
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS campus_events')
  const table = sql.slice(start, sql.indexOf(');', start))
  for (const column of [...COLUMNS, 'last_seen_at', 'classifier']) {
    assert.match(table, new RegExp(`^\\s+${column}\\s`, 'm'), `campus_events has no ${column} column`)
  }
  const checked = (column) => {
    const at = table.indexOf(`CHECK (${column} IN (`)
    assert.ok(at >= 0, `no CHECK on ${column}`)
    return [...table.slice(at, table.indexOf('))', at)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  }
  assert.deepEqual(checked('category'), [...CATEGORIES])
  assert.deepEqual(checked('venue_kind'), [...VENUE_KINDS])
  assert.deepEqual(SOURCES.map((source) => source.key), ['purdue_events', 'iu_events', 'boilerlink', 'thespot'])
  assert.deepEqual(SOURCES.filter((source) => source.engage).map((source) => source.key), ['boilerlink', 'thespot'])
})
