// Jev at ingest for the shared campus events (issue #30,
// docs/campus-events-ingest.md#jev-classification).
//
// The rules in src/sharedEvents.mjs fill free_food, open_to_all, category and
// venue_kind from each source's own signals. With CAMPUS_EVENTS_CLASSIFY on and
// TYPESAFE_API_KEY set, the ingest also asks Jev (src/jevClient.mjs) four
// questions about every listing it holds no current verdict for, stores the
// answers in `classifier`, and combines them with the rules: a verdict changes
// a column only where the 2026-10-18 evals showed it right, and never overrides
// the source's own word (its free food tag, a deadline). `shadow` stores the
// verdicts and changes nothing, so they can be read before they count.
//
// The model, the questions and the thresholds live here together and move
// together. A verdict records the model and a hash of the questions; one asked
// of another model or other questions is asked again. Thresholds apply each
// time a row is written, so retuning one asks Jev nothing.

import { createHash } from 'node:crypto'
import { queryError, retryOnceIfTransient } from './cronTick.mjs'
import { createJevClient } from './jevClient.mjs'
import { CATEGORIES, VENUE_KINDS } from './sharedEvents.mjs'

/**
 * Pinned, never an alias: `jev-latest` moves when TypeSafe ships, and the
 * thresholds below were tuned on this version. Re-run the eval before moving
 * (docs/campus-events-ingest.md#jev-classification).
 */
export const JEV_MODEL = 'jev-1.13.0'

/**
 * The questions, as evaluated on 2026-10-18. Jev reads the state once and
 * answers each question on its own, so every question carries its own
 * definitions and a catch-all. The choice keys are the CHECK values of
 * campus_events.category and venue_kind. Question keys never reach the model;
 * option keys do, together with their descriptions.
 */
export const EVENT_QUESTIONS = Object.freeze({
  category: {
    type: 'choice',
    instructions: 'Pick the main kind of event this listing describes, judged by what attendees will mostly do there.',
    criteria: {
      career: 'Career fairs, employer info sessions, recruiting, networking nights with companies, resume reviews, interview prep, internship and job workshops.',
      academic: 'Talks, lectures, research seminars, tutoring, study sessions, academic workshops, graduate school or study abroad information. Not employer recruiting.',
      social: 'Socials, mixers, game nights, movie nights, parties, crafts, hangouts and welcome events whose main point is meeting people and having fun.',
      club_business: 'A club running itself: general body meetings, officer or committee meetings, elections, callouts or interest meetings for joining, advisor check-ins.',
      sports_fitness: 'Games, matches, tournaments, practices, club sports, intramurals, runs, climbing, fitness classes, outdoor recreation, sports watch parties.',
      arts_culture: 'Concerts, performances, rehearsals for a show, theater, dance, exhibits, film screenings, cultural or heritage celebrations, festivals.',
      service: 'Volunteering, community service, philanthropy, fundraisers, donation drives, charity races.',
      faith: 'Worship, Bible study, prayer, religious holiday observances, faith fellowship.',
      wellness: 'Mental health, counseling, mindfulness, health screenings, substance awareness, self-care workshops.',
      other: 'None of the above, or the listing is too vague to tell.',
    },
  },
  free_food: {
    type: 'noul',
    instructions: 'Attendees are offered food or drinks at no cost at this event.',
    criteria: {
      true: 'The listing says food, snacks, drinks, pizza, coffee, boba, candy, treats or a meal will be provided, served, handed out or included free, for example "food provided", "refreshments", "we will be serving food", "s\'mores", "popcorn bar".',
      false: 'Food is not mentioned; or it must be bought (bake sale, fundraiser, cheap coffee, a ticket that includes dinner); or attendees bring it (potluck, bring a dish); or food is only the topic (a nutrition talk).',
    },
  },
  where: {
    type: 'choice',
    instructions: 'Where does this event take place?',
    criteria: {
      indy_campus: 'On the shared Purdue Indianapolis and IU Indianapolis campus downtown (Campus Center, ET, SL, IO or Innovation Hall, Hine Hall, PE or the Natatorium, The Jungle, Boiler Park) or elsewhere in downtown Indianapolis.',
      west_lafayette: "On Purdue's West Lafayette campus or in Lafayette (WALC, PMU, Beering Hall, the CoRec, Mackey Arena, Ross-Ade Stadium, West Lafayette residence halls).",
      online: 'Online only: Zoom, Teams, a livestream or another virtual meeting.',
      elsewhere: 'Somewhere else: an away game, a trip, a conference or venue in another city, or an Indianapolis venue far from downtown.',
      unknown: 'The listing does not say or imply where it is.',
    },
  },
  open_to_all: {
    type: 'noul',
    instructions: 'A student who is not already a member of the organizing group could show up to this event.',
    criteria: {
      true: 'Advertised to all students or the public: socials, talks, info sessions, tabling, performances, callouts, fairs, open meetings.',
      false: 'Meant for existing members or a closed group: team practices, rehearsals, officer or committee meetings, members-only events, tryout or invitation-only events, closed registrations.',
    },
  },
})

/**
 * Where each answer starts to count, from the 2026-10-18 evals: Jev on the 305
 * rows a run plans (Purdue 40, IU 194, BoilerLink 71) against the rules, plus
 * 170 BoilerLink listings against their organizers' tags. Two identical runs
 * flipped none of these decisions; reversing the order of the options flipped
 * one free food answer that sat on the line (0.68 against 0.70).
 */
export const THRESHOLDS = Object.freeze({
  // free_food at or above: free food. At 0.7 Jev added the free food the rules
  // missed ("free Caribou Coffee", "coffee and cookies"); between 0.5 and 0.7
  // sat a brown bag talk, a chili cook-off and a staff luncheon.
  freeFood: 0.7,
  // open_to_all below: not for students at large. Only an instructors'
  // meeting, a staff luncheon and a faculty and staff lunch scored under it;
  // practices and rehearsals scored 0.19 to 0.33, and the title rule has them.
  closed: 0.2,
  // open_to_all at or above: open to everyone, where the rules said nothing.
  open: 0.8,
  // The share of probability on Jev's category: at 0.7 it fills one the source
  // left empty (its picks below that moved when the options were reversed); at
  // 0.9 it replaces the source's (every replacement at 0.9 was right: mental
  // well-being workshops are wellness, a campus cleanup is service).
  categoryFill: 0.7,
  categoryOverride: 0.9,
  // The share on `where`'s choice, applied only to an `unknown` venue and only
  // for online or elsewhere: Jev placed 60 of 100 West Lafayette events on this
  // campus, so it never says indy_campus or west_lafayette here.
  venue: 0.9,
})

/** Rows asked per run, how long a run may spend asking, and how many calls at a time. */
export const CLASSIFY_MAX_ROWS = 400
export const CLASSIFY_BUDGET_MS = 90_000
export const CLASSIFY_CONCURRENCY = 4
// Calls that fail in a row before a run stops asking: Jev is down, and the
// rows keep to the rules until the next run.
const MAX_FAILURES_IN_A_ROW = 5
const READ_CHUNK = 100
const CHANGE_EXAMPLES = 20
const DESCRIPTION_LIMIT = 1500
const CAMPUS_TIME_ZONE = 'America/Indiana/Indianapolis'
const CLASSIFIED_COLUMNS = ['free_food', 'open_to_all', 'category', 'venue_kind']
// The venue kinds Jev may give an `unknown` row (see THRESHOLDS.venue).
const VENUE_FILLS = Object.freeze(VENUE_KINDS.filter((kind) => kind === 'online' || kind === 'elsewhere'))

// What eventState sends. Change it with the questions: it is part of the version.
const STATE_FORMAT = 'title, location, starts (Indianapolis time), description cut at 1500'

/** A hash of the questions and the state they read: a verdict under another one is asked again. */
export const QUESTIONS_VERSION = createHash('sha256')
  .update(JSON.stringify({ questions: EVENT_QUESTIONS, state: STATE_FORMAT }))
  .digest('hex')
  .slice(0, 12)

/** CAMPUS_EVENTS_CLASSIFY to a mode: `on` (also `1`, `true`), `shadow`, or `off` for anything else. */
export function classifyModeFromSetting(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (['on', '1', 'true'].includes(text)) return 'on'
  if (text === 'shadow') return 'shadow'
  return 'off'
}

const WHEN = new Intl.DateTimeFormat('en-US', {
  timeZone: CAMPUS_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const DAY = new Intl.DateTimeFormat('en-US', { timeZone: CAMPUS_TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' })

/**
 * What Jev reads about a row: the listing's own words as named fields, which
 * TypeSafe's docs prefer to one block of text. Only public listing text, never
 * anything about a student.
 */
export function eventState(row) {
  const state = { title: row.title }
  if (row.location) state.location = row.location
  const start = new Date(row.starts_at)
  if (!Number.isNaN(start.getTime())) {
    state.starts = row.all_day ? `${DAY.format(start)} (all day)` : `${WHEN.format(start)} (Indianapolis time)`
  }
  const description = String(row.description ?? '').trim()
  if (description) state.description = description.length > DESCRIPTION_LIMIT ? `${description.slice(0, DESCRIPTION_LIMIT)}...` : description
  return state
}

const isProbability = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

function nouled(answer) {
  if (answer?.type !== 'noul' || !isProbability(answer.noul)) return null
  return { p: answer.noul }
}

function chosen(answer, options) {
  if (answer?.type !== 'choice' || !options.includes(answer.choice)) return null
  const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
  const p = probabilities[answer.choice]
  return { choice: answer.choice, p: isProbability(p) ? p : 0, probabilities }
}

/**
 * The stored form of one Jev answer (the `classifier` column): the model that
 * answered, the question version, when, and every answer with its
 * probabilities, so a threshold can be retuned later without asking again.
 * Null when an answer is missing or malformed.
 */
export function verdictFrom({ model, answers } = {}, now = new Date()) {
  const verdict = {
    model: String(model || JEV_MODEL),
    questions: QUESTIONS_VERSION,
    classified_at: now.toISOString(),
    answers: {
      free_food: nouled(answers?.free_food),
      open_to_all: nouled(answers?.open_to_all),
      category: chosen(answers?.category, Object.keys(EVENT_QUESTIONS.category.criteria)),
      where: chosen(answers?.where, Object.keys(EVENT_QUESTIONS.where.criteria)),
    },
  }
  return Object.values(verdict.answers).every(Boolean) ? verdict : null
}

/** Whether a stored verdict answers today's questions on today's model. */
export function verdictIsCurrent(verdict) {
  return Boolean(
    verdict &&
      verdict.model === JEV_MODEL &&
      verdict.questions === QUESTIONS_VERSION &&
      verdict.answers?.free_food &&
      verdict.answers?.open_to_all &&
      verdict.answers?.category &&
      verdict.answers?.where,
  )
}

/**
 * The row as a verdict refines it (pure). `sourceFreeFood` is whether the
 * source itself says the event has free food (sharedEvents.planCampusEvents).
 * - free_food: the source's word, or Jev at THRESHOLDS.freeFood. Jev stands in
 *   for the keyword matcher, which reads the same text.
 * - open_to_all: false when the rules say so or Jev is under THRESHOLDS.closed,
 *   true when Jev is at THRESHOLDS.open, else the rules' answer. A deadline is
 *   left alone: "University offices closed" is for everyone.
 * - category: a deadline stays. An empty one takes Jev's pick at
 *   THRESHOLDS.categoryFill; the source's is replaced at
 *   THRESHOLDS.categoryOverride.
 * - venue_kind: only an `unknown` one, and only to online or elsewhere at
 *   THRESHOLDS.venue.
 */
export function applyVerdict(row, verdict, { sourceFreeFood = false } = {}) {
  const answers = verdict?.answers
  if (!answers) return row
  const out = { ...row }
  if (answers.free_food) out.free_food = Boolean(sourceFreeFood) || answers.free_food.p >= THRESHOLDS.freeFood
  const deadline = row.category === 'deadline'
  if (answers.open_to_all && !deadline && row.open_to_all !== false) {
    if (answers.open_to_all.p < THRESHOLDS.closed) out.open_to_all = false
    else if (answers.open_to_all.p >= THRESHOLDS.open) out.open_to_all = true
  }
  const category = answers.category
  if (category && !deadline && CATEGORIES.includes(category.choice) && category.choice !== 'deadline') {
    const bar = row.category == null ? THRESHOLDS.categoryFill : THRESHOLDS.categoryOverride
    if (category.p >= bar) out.category = category.choice
  }
  const where = answers.where
  if (where && row.venue_kind === 'unknown' && VENUE_FILLS.includes(where.choice) && where.p >= THRESHOLDS.venue) {
    out.venue_kind = where.choice
  }
  return out
}

/** Stored verdicts of the planned rows that have one, by dedupe_key, read in chunks. */
async function readStoredVerdicts(client, keys, { log, sleep }) {
  const stored = new Map()
  for (let i = 0; i < keys.length; i += READ_CHUNK) {
    const chunk = keys.slice(i, i + READ_CHUNK)
    const data = await retryOnceIfTransient(
      '[campus-events] verdict read',
      async () => {
        const result = await client
          .from('campus_events')
          .select('dedupe_key, content_hash, classifier')
          .in('dedupe_key', chunk)
          .not('classifier', 'is', null)
        if (result.error) throw queryError(result, 'campus_events verdict read')
        return result.data ?? []
      },
      { log, sleep },
    )
    for (const row of data) stored.set(row.dedupe_key, row)
  }
  return stored
}

/**
 * Refine the planned rows with Jev. Rows whose stored verdict answers the same
 * text (content_hash) under today's model and questions reuse it; the rest are
 * asked, soonest first, up to `maxRows` and within `budgetMs`, `concurrency` at
 * a time. A failed call leaves its row to the rules (and to the next run); a
 * fatal one (a bad key, a malformed question) or MAX_FAILURES_IN_A_ROW stops
 * the asking, never the run. Only a failed read of the stored verdicts
 * rejects, as a failed write would.
 *
 * Every row with a verdict carries it in `classifier`; with mode `on` its
 * columns are refined (applyVerdict), with `shadow` they stay the rules'.
 * Resolves with `{ rows, summary }`; the summary counts what was reused,
 * asked, answered, failed and left for later, and what the verdicts changed
 * (or, in shadow, would change).
 */
export async function classifyCampusEvents(
  rows,
  {
    client,
    jev,
    mode = 'on',
    sourceFreeFood = new Set(),
    maxRows = CLASSIFY_MAX_ROWS,
    budgetMs = CLASSIFY_BUDGET_MS,
    concurrency = CLASSIFY_CONCURRENCY,
    clock = Date.now,
    now = () => new Date(),
    log = console,
    sleep,
  } = {},
) {
  const startedAt = clock()
  const summary = {
    mode,
    model: JEV_MODEL,
    rows: rows.length,
    reused: 0,
    asked: 0,
    answered: 0,
    failed: 0,
    deferred: 0,
    stopped: null,
    inputTokens: 0,
    changed: Object.fromEntries(CLASSIFIED_COLUMNS.map((column) => [column, 0])),
    examples: [],
    durationMs: 0,
  }
  if (rows.length === 0) return { rows, summary }

  const stored = await readStoredVerdicts(client, rows.map((row) => row.dedupe_key), { log, sleep })
  const verdicts = new Map()
  const toAsk = []
  for (const row of rows) {
    const prior = stored.get(row.dedupe_key)
    if (prior && prior.content_hash === row.content_hash && verdictIsCurrent(prior.classifier)) {
      verdicts.set(row.dedupe_key, prior.classifier)
      summary.reused += 1
    } else {
      toAsk.push(row)
    }
  }

  const queue = toAsk.slice(0, maxRows)
  let next = 0
  let stop = null
  let fatal = false
  let failuresInARow = 0
  let lastError = null
  const worker = async () => {
    while (next < queue.length && !stop) {
      if (clock() - startedAt >= budgetMs) {
        stop = 'time budget'
        break
      }
      const row = queue[next]
      next += 1
      summary.asked += 1
      try {
        const answer = await jev.evaluate(eventState(row), EVENT_QUESTIONS)
        const verdict = verdictFrom(answer, now())
        if (!verdict) throw new Error('Jev answered without all four answers')
        verdicts.set(row.dedupe_key, verdict)
        summary.answered += 1
        summary.inputTokens += Number(answer.usage?.input_tokens) || 0
        failuresInARow = 0
      } catch (error) {
        summary.failed += 1
        failuresInARow += 1
        lastError = String(error?.message || error)
        if (error?.fatal) {
          fatal = true
          stop ??= `Jev error: ${lastError}`
        } else if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          stop ??= `${failuresInARow} failed calls in a row`
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  summary.stopped = stop ?? (toAsk.length > queue.length ? 'row cap' : null)
  summary.deferred = toAsk.length - summary.answered
  if (fatal) log.error(`[campus-events] Jev stopped: ${lastError}`)
  else if (summary.failed > 0) log.warn(`[campus-events] Jev: ${summary.failed} of ${summary.asked} calls failed (last: ${lastError}); those rows keep to the rules`)

  const out = rows.map((row) => {
    const verdict = verdicts.get(row.dedupe_key)
    if (!verdict) return row
    const refined = applyVerdict(row, verdict, { sourceFreeFood: sourceFreeFood.has(row.dedupe_key) })
    for (const column of CLASSIFIED_COLUMNS) {
      if (refined[column] === row[column]) continue
      summary.changed[column] += 1
      if (summary.examples.length < CHANGE_EXAMPLES) {
        summary.examples.push({ dedupe_key: row.dedupe_key, title: row.title, column, from: row[column], to: refined[column] })
      }
    }
    return { ...(mode === 'on' ? refined : row), classifier: verdict }
  })
  summary.durationMs = clock() - startedAt
  return { rows: out, summary }
}

/**
 * The `classify` hook for runCampusEventsIngest, or null when classification
 * is off: CAMPUS_EVENTS_CLASSIFY off (the default), or on or shadow without
 * TYPESAFE_API_KEY, which is logged here, once, at boot.
 */
export function createCampusEventsClassifier({ apiKey, setting, fetchImpl, log = console, ...options } = {}) {
  const mode = classifyModeFromSetting(setting)
  if (mode === 'off') return null
  if (!apiKey) {
    log.warn(`[campus-events] CAMPUS_EVENTS_CLASSIFY is ${mode} but TYPESAFE_API_KEY is unset: the ingest keeps to its rules.`)
    return null
  }
  const jev = createJevClient({ apiKey, model: JEV_MODEL, ...(fetchImpl ? { fetchImpl } : {}) })
  const classify = (rows, context = {}) => classifyCampusEvents(rows, { ...options, ...context, jev, mode, log: context.log ?? log })
  classify.mode = mode
  return classify
}
