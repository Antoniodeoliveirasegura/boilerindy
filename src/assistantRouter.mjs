// Grounded assistant intent router (issue #45). Answers common questions from
// the DB with ZERO Gemini tokens. matchIntent is a pure keyword/regex matcher;
// the formatters take already-fetched data and return a reply string (or null
// to fall through to the LLM). All pure → unit-testable without DB/HTTP.

const INTENT_PATTERNS = [
  ['next_class', /\bnext class\b|when'?s?\b.*\bclass\b|my next class/],
  ['classes_today', /\bclass(es)?\b.*\btoday\b|today'?s? classes|do i have class|what classes/],
  ['dining_open', /\bdining\b|dining hall|food court|what'?s on the menu|what'?s for (lunch|dinner|breakfast)|menu today|is (the )?(tower|dining|hall|cafeteria).*open/],
  ['assignments', /\b(assignment|homework|deadline)s?\b|what'?s due|anything due|upcoming due/],
]

/**
 * @param {unknown} message - the latest user message text
 * @returns {string|null} an intent key, or null when nothing matches
 */
export function matchIntent(message) {
  const text = String(message ?? '').toLowerCase().trim()
  if (!text) return null
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(text)) return intent
  }
  return null
}

function startOf(item) {
  return new Date(item.startTime ?? item.start_time ?? item.start ?? 0)
}

function timeLabel(date, timeZone) {
  return date.toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function sameZonedDay(a, b, timeZone) {
  const fmt = (d) => d.toLocaleDateString('en-CA', { timeZone })
  return fmt(a) === fmt(b)
}

/** @returns {string|null} */
export function formatNextClass(classItems, now = new Date(), timeZone = 'America/Indiana/Indianapolis') {
  const upcoming = (classItems || [])
    .filter((c) => startOf(c) > now)
    .sort((a, b) => startOf(a) - startOf(b))
  if (!upcoming.length) return null
  const c = upcoming[0]
  const where = c.location ? ` in ${c.location}` : ''
  return `Your next class is ${c.title}${where}, ${timeLabel(startOf(c), timeZone)}.`
}

/** @returns {string|null} */
export function formatClassesToday(classItems, now = new Date(), timeZone = 'America/Indiana/Indianapolis') {
  const today = (classItems || [])
    .filter((c) => sameZonedDay(startOf(c), now, timeZone))
    .sort((a, b) => startOf(a) - startOf(b))
  if (!today.length) return 'You have no classes scheduled for today.'
  const lines = today.map((c) => {
    const t = startOf(c).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    return `• ${t} — ${c.title}${c.location ? ` (${c.location})` : ''}`
  })
  return `You have ${today.length} class${today.length === 1 ? '' : 'es'} today:\n${lines.join('\n')}`
}

/** @returns {string|null} */
export function formatDiningOpen(diningData) {
  const locations = diningData?.locations
  if (!Array.isArray(locations) || locations.length === 0) return null
  const open = locations.filter((l) => l.is_open)
  if (!open.length) {
    return 'No dining locations are open right now. Check the Dining page for today’s hours.'
  }
  const lines = open.map((l) => `• ${l.name}${l.hours ? ` — ${l.hours}` : ''}`)
  return `Open dining locations right now:\n${lines.join('\n')}`
}

/** @returns {string|null} */
export function formatAssignments(items, now = new Date(), timeZone = 'America/Indiana/Indianapolis') {
  const upcoming = (items || [])
    .filter((c) => startOf(c) >= new Date(now.getTime() - 60 * 60 * 1000))
    .sort((a, b) => startOf(a) - startOf(b))
    .slice(0, 5)
  if (!upcoming.length) return 'You have no upcoming assignments on your calendar.'
  const lines = upcoming.map((c) => `• ${timeLabel(startOf(c), timeZone)} — ${c.title}`)
  return `Your next ${upcoming.length} deadline${upcoming.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}

export const ASSISTANT_OFFLINE_MESSAGE =
  "I can still answer schedule and dining questions, but the open-ended AI assistant is offline right now. Try asking about your next class, today's classes, what's due, or whether dining is open."
