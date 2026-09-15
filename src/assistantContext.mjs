// Context blocks for the campus assistant's system prompt (issue #253).
//
// Every /api/assistant call sends the system prompt plus this context to Groq,
// and the free tier meters tokens per minute and per day for the whole
// organisation, so the context carries only what a question can use: menus
// for the locations that are open right now, and the study and help hints
// only when the question is about studying. Pure, so it can be tested.

// Diet tags worth a few tokens each; the rest of Nutrislice's icons are noise here.
const DIET_TAGS = ['Vegan', 'Vegetarian', 'Avoiding Gluten']
export const DINING_ITEMS_PER_STATION = 5

/**
 * Today's dining for the prompt, from a getDiningSnapshot() payload. Open
 * locations list their stations (at most DINING_ITEMS_PER_STATION items each,
 * diet tags kept, calories dropped); closed ones get a single line. Returns ''
 * when there is no usable snapshot.
 */
export function buildDiningContext(dining) {
  if (!dining?.ok || !dining.locations?.length) return ''
  const lines = [`=== DINING TODAY (${dining.date}) ===`]
  for (const loc of dining.locations) {
    if (loc.is_open !== true) {
      lines.push(`${loc.name}: CLOSED${loc.opens_at ? ` - opens ${loc.opens_at}` : ''}`)
      continue
    }
    // "until 9:00 PM" says all an open location needs; 24-hour days keep their label.
    const hrs = loc.closes_at ? ` until ${loc.closes_at}` : loc.hours && !/^Closed/.test(loc.hours) ? ` - ${loc.hours}` : ''
    lines.push(`${loc.name}: OPEN${hrs}`)
    if (loc.stations?.length) {
      for (const station of loc.stations) {
        const items = (station.items || []).slice(0, DINING_ITEMS_PER_STATION).map((it) => {
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
