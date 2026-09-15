// Validation for the user profile fields clients send on register, supabase-sync
// and PATCH /api/me/profile (issue #199).
//
// Display names are rendered for every user on the board, replies, study groups,
// marketplace and connections, so an unbounded or non-string name either
// inflates every list response or throws a TypeError from `.trim`. Avatar URLs
// and the auth provider were stored exactly as the client sent them.

export const MAX_DISPLAY_NAME = 80
export const MAX_AVATAR_URL = 2048
export const ALLOWED_AUTH_PROVIDERS = Object.freeze(['email', 'google', 'apple', 'github', 'azure', 'supabase', 'local'])

export const DISPLAY_NAME_MESSAGE = `Display name must be text up to ${MAX_DISPLAY_NAME} characters.`
export const AVATAR_URL_MESSAGE = `Avatar URL must be an https link up to ${MAX_AVATAR_URL} characters.`

/**
 * `{ ok: true, value }` with the name trimmed and inner whitespace collapsed, or
 * null when nothing was sent; `{ ok: false, message }` for a non-string or a
 * name over MAX_DISPLAY_NAME. With `truncate`, an over-long string is cut to
 * the cap instead of rejected (sign-in paths, where the name comes from the
 * OAuth provider and the user cannot shorten it).
 */
export function normalizeDisplayName(value, { truncate = false } = {}) {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: DISPLAY_NAME_MESSAGE }
  const name = value.replace(/\s+/g, ' ').trim()
  if (!name) return { ok: true, value: null }
  if (name.length <= MAX_DISPLAY_NAME) return { ok: true, value: name }
  if (!truncate) return { ok: false, message: DISPLAY_NAME_MESSAGE }
  let cut = name.slice(0, MAX_DISPLAY_NAME)
  // Do not leave half of a surrogate pair (an emoji cut in two) at the end.
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return { ok: true, value: cut.trimEnd() }
}

/**
 * `{ ok: true, value }` for an https URL up to MAX_AVATAR_URL characters (null
 * when nothing was sent); `{ ok: false, message }` for anything else, including
 * http:, javascript: and data: URLs.
 */
export function normalizeAvatarUrl(value) {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: AVATAR_URL_MESSAGE }
  const url = value.trim()
  if (!url) return { ok: true, value: null }
  if (url.length > MAX_AVATAR_URL) return { ok: false, message: AVATAR_URL_MESSAGE }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, message: AVATAR_URL_MESSAGE }
  }
  if (parsed.protocol !== 'https:') return { ok: false, message: AVATAR_URL_MESSAGE }
  return { ok: true, value: url }
}

/** The provider when it is on the allowlist, otherwise `fallback`. */
export function normalizeProvider(value, fallback) {
  if (typeof value !== 'string') return fallback
  const provider = value.trim().toLowerCase()
  return ALLOWED_AUTH_PROVIDERS.includes(provider) ? provider : fallback
}
