import { sanitizeSignupRef, signupRefFromSearch } from '../../../src/signupRef.mjs'

// The sign-up source: the marketing link a visitor arrived on (?ref=flyer-a,
// or ?utm_source=instagram), kept in this tab until the request that creates
// their account carries it: POST /api/auth/register-supabase for an email
// sign-up, POST /api/auth/supabase-sync after the Google round trip.
// sessionStorage survives the redirect to Google and back, as postAuthNext
// does, and is gone when the tab closes; nothing else reads it and it is never
// sent anywhere else. The slug rule is src/signupRef.mjs, shared with the API,
// which sanitizes again and saves it once (docs/analytics.md).

const KEY = 'boilerindy-signup-ref'

/**
 * Keeps the ref in a page's query string, when it carries a usable one; a page
 * without one leaves the ref already held alone. main.tsx calls this once per
 * page load, before the app renders, so any landing page counts.
 */
export function captureSignupRef(search: string): string | null {
  const ref = signupRefFromSearch(search)
  if (!ref) return null
  try {
    sessionStorage.setItem(KEY, ref)
  } catch {
    /* storage unavailable */
  }
  return ref
}

/** The ref this tab holds, or null. Read through the slug rule again. */
export function readSignupRef(): string | null {
  try {
    return sanitizeSignupRef(sessionStorage.getItem(KEY))
  } catch {
    return null
  }
}

/** Forgets the ref: an account request carrying it went through. */
export function clearSignupRef(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* storage unavailable */
  }
}

/** The body field an account-creating request adds: { signupRef } when a ref is held. */
export function signupRefField(): { signupRef?: string } {
  const signupRef = readSignupRef()
  return signupRef ? { signupRef } : {}
}
