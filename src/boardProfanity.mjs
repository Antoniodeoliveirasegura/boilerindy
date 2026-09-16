/**
 * Community text policy: block profanity and slurs server-side.
 *
 * Despite the name, this gates every community write, not only the campus
 * board: lost and found, board posts and replies, guide posts, study groups,
 * marketplace listings and the friend profile bio.
 *
 * Extend with BOARD_BLOCKED_WORDS=comma,separated. Entries are trimmed and
 * lowercased, and anything shorter than 2 characters is ignored. Use it to add
 * a word back that the base list below leaves out. The matcher is built once
 * per process, so a change to BOARD_BLOCKED_WORDS needs a server restart.
 */

export const BOARD_PROFANITY_USER_MESSAGE =
  'Please keep the campus board respectful - remove profanity or slurs and try again.'

// Inclusion rule (issue #209): slurs, sexual acts and objects, and strong
// profanity only. Anatomy terms, mild British slang and words with common
// benign meanings stay out, because matching is whole-word with no context and
// a hit hard-blocks the write ("the flange on the pump", "Homo sapiens lab
// report", "muff coupling"). Words are matched case-insensitively on word
// boundaries after NFKC normalization. The regex is built from this list plus
// BOARD_BLOCKED_WORDS on first use and cached for the process lifetime.
const BASE_BLOCKED = [
  'asshole',
  'bastard',
  'bitch',
  'blowjob',
  'buttplug',
  'cock',
  'cunt',
  'dick',
  'dildo',
  'fag',
  'faggot',
  'felching',
  'fellatio',
  'fuck',
  'fucking',
  'fudgepacker',
  'jizz',
  'motherfucker',
  'nigger',
  'nigga',
  'porn',
  'prick',
  'pussy',
  'shit',
  'sh1t',
  'slut',
  'smegma',
  'twat',
  'whore',
]

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extraFromEnv() {
  const raw = process.env.BOARD_BLOCKED_WORDS
  if (!raw || typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((w) => w.length >= 2)
}

let _matcher = null

function matcher() {
  if (_matcher) return _matcher
  const words = [...new Set([...BASE_BLOCKED.map((w) => w.toLowerCase()), ...extraFromEnv()])].sort(
    (a, b) => b.length - a.length,
  )
  const body = words.map(escapeRe).join('|')
  _matcher = new RegExp(`\\b(?:${body})\\b`, 'iu')
  return _matcher
}

export function boardTextFailsPolicy(text) {
  if (!text || typeof text !== 'string') return false
  const normalized = text.normalize('NFKC')
  return matcher().test(normalized)
}

export function assertBoardPostTextAllowed(title, body) {
  const combined = `${String(title || '')}\n${String(body || '')}`
  if (boardTextFailsPolicy(combined)) {
    return { ok: false, message: BOARD_PROFANITY_USER_MESSAGE }
  }
  return { ok: true }
}

export function __resetProfanityMatcherForTests() {
  _matcher = null
}
