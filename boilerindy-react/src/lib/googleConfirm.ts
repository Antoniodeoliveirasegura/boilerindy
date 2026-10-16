// Confirm with Google (Settings) sends a Google account back to Google to prove
// it is still theirs. Google can return any account signed in to the browser,
// so Settings notes which one it expects here, and AuthCallback checks the one
// that came back: another account's Supabase session is dropped there (the
// server already refused it, POST /api/auth/supabase-sync), or the next page
// load would sign this browser into that account.

const KEY = 'googleConfirm'
// Under the server's 10 minutes (PROVIDER_CONFIRM_MS in src/routes/auth.mjs),
// so the server still holds the ask whenever this side treats a return as one.
const PENDING_MS = 9 * 60 * 1000

export type PendingGoogleConfirm = { email: string; forDelete: boolean }

export function normalizeEmail(email: string | null | undefined): string {
  return (email || '').trim().toLowerCase()
}

export function startGoogleConfirm(email: string, forDelete: boolean): void {
  sessionStorage.setItem(KEY, JSON.stringify({ email: normalizeEmail(email), forDelete, at: Date.now() }))
}

export function clearGoogleConfirm(): void {
  sessionStorage.removeItem(KEY)
}

/** The pending confirmation, removed as it is read; null when none is pending. */
export function takeGoogleConfirm(now = Date.now()): PendingGoogleConfirm | null {
  const raw = sessionStorage.getItem(KEY)
  sessionStorage.removeItem(KEY)
  if (!raw) return null
  try {
    const { email, forDelete, at } = JSON.parse(raw) as { email?: unknown; forDelete?: unknown; at?: unknown }
    if (typeof email !== 'string' || !email || typeof at !== 'number' || now - at > PENDING_MS || at > now) return null
    return { email, forDelete: forDelete === true }
  } catch {
    return null
  }
}
