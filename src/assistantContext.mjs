// Context blocks for the campus assistant's system prompt (issue #253).
//
// Every /api/assistant call sends the system prompt plus this context to Groq,
// and the free tier meters tokens per minute and per day for the whole
// organisation, so the context carries only what a question can use: the
// current meal's menu for the locations that are open right now, and the
// study and help hints only when the question is about studying. Pure, so it
// can be tested.

import { FALLBACK_TZ, wallClockMinutesInTimeZone } from './nutrisliceDining.mjs'

// Diet tags worth a few tokens each; the rest of Nutrislice's icons are noise here.
const DIET_TAGS = ['Vegan', 'Vegetarian', 'Avoiding Gluten']
export const DINING_ITEMS_PER_STATION = 5

// Nutrislice says which meals a hall posts but not when they are served, so
// the clock decides, on Tower Dining's usual windows (breakfast until 10:30 AM,
// dinner from 4:30 PM). Brunch stands in for breakfast or lunch on days that
// post it.
const MEAL_WINDOWS = [
  { until: 10 * 60 + 30, meals: ['breakfast', 'brunch'] },
  { until: 16 * 60 + 30, meals: ['lunch', 'brunch'] },
  { until: 24 * 60, meals: ['dinner'] },
]
const MEAL_WORD_RE = /\b(breakfast|brunch|lunch|dinner)\b/i

/**
 * The meal slugs worth listing, best first: the meal the question names
 * ("what's for dinner" at noon), otherwise the one being served at `now` in
 * `timeZone`.
 */
export function mealsForPrompt(now = new Date(), question = '', timeZone = FALLBACK_TZ) {
  const named = MEAL_WORD_RE.exec(String(question ?? ''))
  if (named) return [named[1].toLowerCase()]
  const minutes = wallClockMinutesInTimeZone(now, timeZone)
  return MEAL_WINDOWS.find((w) => minutes < w.until).meals
}

/**
 * The first of `wanted` that any item at this location is served at, or null
 * when none is (no `meals` on the items, or a day that posts other meals), in
 * which case every item is listed.
 */
function pickMeal(stations, wanted) {
  return wanted.find((meal) => stations.some((s) => (s.items || []).some((it) => it.meals?.includes(meal)))) ?? null
}

/**
 * Today's dining for the prompt, from a getDiningSnapshot() payload. Open
 * locations list their stations for the current meal (see mealsForPrompt; at
 * most DINING_ITEMS_PER_STATION items each, diet tags kept, calories dropped);
 * closed ones get a single line. `question` is the student's latest message.
 * Returns '' when there is no usable snapshot.
 */
export function buildDiningContext(dining, { now = new Date(), question = '' } = {}) {
  if (!dining?.ok || !dining.locations?.length) return ''
  const wanted = mealsForPrompt(now, question, dining.timezone || FALLBACK_TZ)
  const lines = [`=== DINING TODAY (${dining.date}) ===`]
  for (const loc of dining.locations) {
    if (loc.is_open !== true) {
      lines.push(`${loc.name}: CLOSED${loc.opens_at ? ` - opens ${loc.opens_at}` : ''}`)
      continue
    }
    const stations = loc.stations || []
    const meal = stations.length ? pickMeal(stations, wanted) : null
    // "until 9:00 PM" says all an open location needs; 24-hour days keep their label.
    const hrs = loc.closes_at ? ` until ${loc.closes_at}` : loc.hours && !/^Closed/.test(loc.hours) ? ` - ${loc.hours}` : ''
    lines.push(`${loc.name}: OPEN${hrs}${meal ? ` (${meal} menu)` : ''}`)
    if (stations.length) {
      for (const station of stations) {
        const items = (station.items || [])
          .filter((it) => !meal || it.meals?.includes(meal))
          .slice(0, DINING_ITEMS_PER_STATION)
          .map((it) => {
            const tags = (it.icons || []).filter((t) => DIET_TAGS.includes(t))
            return `${it.name}${tags.length ? ` (${tags.join('/')})` : ''}`
          })
        if (items.length) lines.push(`  ${station.name}: ${items.join(', ')}`)
      }
    } else if (loc.meal) {
      // The hint is already a sentence: "Menus: lunch, dinner", "Menu not
      // posted yet" or "Retail dining, no posted menu".
      lines.push(`  ${loc.meal}`)
    }
  }
  return lines.join('\n')
}

// The words that make the ON-CAMPUS STUDY & HELP block worth sending. Plurals
// and -ing forms count too ("studying", "exams", "tutoring").
const STUDY_HELP_RE = /\b(stud(y|ying|ies)|librar(y|ies)|tutor(s|ing)?|quiet|focus|exams?|homework|where (can|should) i)\b/i

/** True when the student's latest message is about studying or getting help. */
export function wantsStudyHelp(message) {
  return STUDY_HELP_RE.test(String(message ?? ''))
}

// The system prompt has the model plan work around homework due in the next
// 24-48 hours and suggest study spots for it, so a deadline this close brings
// the study block along even when the question does not mention studying.
export const STUDY_HELP_DEADLINE_HOURS = 48

/** True when any row's start_time falls between `now` and `hours` later. */
export function startsWithin(rows, now = new Date(), hours = STUDY_HELP_DEADLINE_HOURS) {
  const from = now.getTime()
  const to = from + hours * 60 * 60 * 1000
  return (rows || []).some((row) => {
    const t = new Date(row?.start_time).getTime()
    return Number.isFinite(t) && t >= from && t <= to
  })
}
