// The repo conventions that CI, the committed git hooks and
// `pnpm run check:conventions` all enforce, so every contributor gets the same
// answer whether a person or an AI assistant wrote the change. README
// "Conventions" states the rules for humans; this file is the executable form,
// and test/conventions.test.mjs pins it down. scripts/check-conventions.mjs is
// the command-line wrapper.

// Files the dash scan skips: lockfiles and binary assets.
const DASH_EXEMPT = /\.(lock|svg|png|ico|webp|jpe?g|woff2?|ttf)$|pnpm-lock\.yaml$/

// Em dash (U+2014) and en dash (U+2013), built from char codes so this file
// never contains the characters it bans.
const DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')

// Co-author trailers and footers that credit an AI assistant. GitHub turns a
// Co-Authored-By trailer into a contributor badge on the repo, which is why the
// repo bans them (README "Conventions"). A trailer naming a person is fine.
const TRAILER = /^\s*co-authored-by\s*:\s*(.+)$/i
const ASSISTANT = /\b(claude|copilot|codex|chatgpt|gemini)\b|anthropic\.com|openai\.com|cursor\.com/i
const FOOTER = /generated with \[?claude code|generated with claude/i

/** True for paths the dash scan does not read (lockfiles, images, fonts). */
export function isDashExempt(path) {
  return DASH_EXEMPT.test(path)
}

/** Lines of `text` (1-based) that contain an em or en dash, with a short excerpt. */
export function findDashes(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    if (DASH.test(line)) hits.push({ line: i + 1, excerpt: line.trim().slice(0, 80) })
  })
  return hits
}

/** Lines of a commit message or PR body (1-based) that credit an AI assistant. */
export function findAssistantCredits(message) {
  const hits = []
  message.split('\n').forEach((line, i) => {
    const trailer = line.match(TRAILER)
    const flagged = trailer ? ASSISTANT.test(trailer[1]) : FOOTER.test(line)
    if (flagged) hits.push({ line: i + 1, excerpt: line.trim().slice(0, 120) })
  })
  return hits
}
