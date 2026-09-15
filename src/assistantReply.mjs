// Post-processing for LLM replies in the campus assistant (issue #252).
//
// The chat bubble renders a reply as plain text (whitespace-pre-wrap, no
// markdown), and the brand rule bans em and en dashes everywhere, so whatever
// the model does the student should see plain sentences: no **bold**, no
// headings, no dashes. The system prompt asks for that too; this is the
// guarantee, and it is deterministic so it can be tested.

// A dash between two clock times or numbers reads as a range: "11:45 AM to 12:15 PM".
const RANGE_DASH = /([0-9]|AM|PM|am|pm)[ \t]*[\u2013\u2014][ \t]*(?=[0-9])/g

/** Plain text for the chat bubble, or null when there is nothing left. */
export function tidyAssistantReply(text) {
  if (text == null) return null
  let out = String(text)
  out = out.replace(/\*\*(.+?)\*\*/g, '$1') // **bold** -> bold
  out = out.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1$2') // *italic* -> italic
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '') // # Heading -> Heading
  out = out.replace(/^[ \t]*[•\u2013\u2014*][ \t]+/gm, '- ') // bullet glyphs and dash bullets -> "- "
  out = out.replace(RANGE_DASH, '$1 to ')
  out = out.replace(/[ \t]*[\u2013\u2014][ \t]*/g, ', ') // any other em or en dash -> comma
  out = out.replace(/^,[ \t]+/gm, '') // a dash that opened a line leaves no stray comma
  out = out.replace(/\u2011/g, '-') // non-breaking hyphen -> hyphen
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  out = out.trim()
  return out.length ? out : null
}

/**
 * Rough prompt size for the server log (issue #253): about four characters per
 * token for English text. Groq's free tier is metered in tokens per minute and
 * per day for the whole organisation, so this is the number to keep small.
 */
export function estimateTokens(text) {
  if (text == null) return 0
  return Math.ceil(String(text).length / 4)
}
