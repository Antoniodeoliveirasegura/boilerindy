/**
 * Campus board text policy: block profanity and slurs server-side.
 * Extend with BOARD_BLOCKED_WORDS=comma,separated (lowercase, no spaces in words).
 */

export const BOARD_PROFANITY_USER_MESSAGE =
  'Please keep the campus board respectful — remove profanity or slurs and try again.'

const BASE_BLOCKED = [
  'anal',
  'anus',
  'arse',
  'asshole',
  'bastard',
  'bitch',
  'blowjob',
  'bollocks',
  'boner',
  'boob',
  'bugger',
  'buttplug',
  'clitoris',
  'cock',
  'cunt',
  'dick',
  'dildo',
  'fag',
  'faggot',
  'felching',
  'fellatio',
  'flange',
  'fuck',
  'fucking',
  'fudgepacker',
  'homo',
  'jizz',
  'knobend',
  'labia',
  'motherfucker',
  'muff',
  'nigger',
  'nigga',
  'penis',
  'piss',
  'poop',
  'porn',
  'prick',
  'pube',
  'pussy',
  'scrotum',
  'shit',
  'sh1t',
  'slut',
  'smegma',
  'spunk',
  'tosser',
  'turd',
  'twat',
  'vagina',
  'wank',
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
