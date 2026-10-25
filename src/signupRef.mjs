// Sign-up source (users.signup_ref): which marketing link brought each new
// account, so the owner can count sign-ups per channel (a class group chat,
// Instagram, a QR flyer, a student ambassador) with no third-party tracker. A
// link carries a short tag, ?ref=flyer-a, or ?utm_source=instagram from a tool
// that writes UTM tags. The website keeps it in the tab
// (boilerindy-react/src/lib/signupRef.ts) and sends it with the request that
// creates the account, and the server saves it once (src/routes/auth.mjs,
// db/supabase-signup-ref.sql). docs/analytics.md has the whole flow.
//
// Pure, and shared with the website, so the browser and the API apply one slug
// rule. src/signupRefReport.mjs counts the saved refs for scripts/signup-refs.mjs.

/** users.signup_ref is CHECK (char_length(signup_ref) <= 40). */
export const SIGNUP_REF_MAX_LENGTH = 40

/** The query parameters a ref is read from, the first usable one winning. */
export const SIGNUP_REF_PARAMS = Object.freeze(['ref', 'utm_source'])

/**
 * A ref as a short lowercase slug of a-z, 0-9 and single hyphens, at most 40
 * characters, or null. Case and accents are folded and every run of other
 * characters becomes one hyphen, so "Flyer_A" and "flyer a" both read flyer-a;
 * a longer value is cut at 40. A value with an @ is refused: a tag names a
 * link, and an email address in one would put a person in the column.
 * @param {unknown} value
 * @returns {string | null}
 */
export function sanitizeSignupRef(value) {
  if (typeof value !== 'string' || value.includes('@')) return null
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SIGNUP_REF_MAX_LENGTH)
    .replace(/-$/, '')
  return slug || null
}

/**
 * The ref a page's query string carries: ?ref= first, then ?utm_source=, each
 * sanitized, so an unusable ref still lets a good utm_source through. Null when
 * neither gives a slug.
 * @param {string} search a query string, with or without its leading ?
 * @returns {string | null}
 */
export function signupRefFromSearch(search) {
  const params = new URLSearchParams(search)
  for (const name of SIGNUP_REF_PARAMS) {
    const ref = sanitizeSignupRef(params.get(name))
    if (ref) return ref
  }
  return null
}
