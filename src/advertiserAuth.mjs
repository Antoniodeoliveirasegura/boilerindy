// Pure input validation/normalization for the advertiser portal, kept out of
// server.mjs so it can be unit-tested without a live Supabase. The DB writes and
// session handling stay in the server (imperative shell); this module only
// validates and shapes the data that goes into the `advertisers` /
// `advertiser_leads` tables (see supabase-advertiser-portal.sql).

export const ADVERTISER_PASSWORD_MIN_LENGTH = 8
export const COMPANY_NAME_MAX_LENGTH = 200
export const LEAD_MESSAGE_MAX_LENGTH = 2000

export function normalizeAdvertiserEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function isLikelyEmail(email) {
  return email.length >= 3 && email.length <= 320 && email.includes('@') && !/\s/.test(email)
}

/**
 * Validate advertiser sign-in input.
 * @param {{ email?: string, password?: string }} input
 * @returns {{ email: string, password: string }}
 * @throws {Error} with a user-facing message when invalid
 */
export function normalizeAdvertiserSignIn(input = {}) {
  const email = normalizeAdvertiserEmail(input.email)
  const password = typeof input.password === 'string' ? input.password : ''
  if (!isLikelyEmail(email)) {
    throw new Error('Enter a valid business email.')
  }
  if (!password) {
    throw new Error('Enter your password.')
  }
  return { email, password }
}

/**
 * Validate and shape a "Request advertiser access" lead.
 * @param {{ email?: string, companyName?: string, message?: string }} input
 * @returns {{ email: string, companyName: string|null, message: string|null }}
 * @throws {Error} with a user-facing message when invalid
 */
export function normalizeLeadInput(input = {}) {
  const email = normalizeAdvertiserEmail(input.email)
  if (!isLikelyEmail(email)) {
    throw new Error('Enter a valid business email so we can reach you.')
  }

  const companyRaw = typeof input.companyName === 'string' ? input.companyName.trim() : ''
  if (companyRaw.length > COMPANY_NAME_MAX_LENGTH) {
    throw new Error(`Company name must be ${COMPANY_NAME_MAX_LENGTH} characters or fewer.`)
  }

  const messageRaw = typeof input.message === 'string' ? input.message.trim() : ''
  if (messageRaw.length > LEAD_MESSAGE_MAX_LENGTH) {
    throw new Error(`Message must be ${LEAD_MESSAGE_MAX_LENGTH} characters or fewer.`)
  }

  return {
    email,
    companyName: companyRaw || null,
    message: messageRaw || null,
  }
}

/**
 * Validate the fields needed to mint an advertiser account (seed script + any
 * future admin path). Does not hash - callers pass the result to passwordHash.
 * @param {{ email?: string, password?: string, companyName?: string, contactName?: string }} input
 * @returns {{ email: string, password: string, companyName: string, contactName: string|null }}
 * @throws {Error} when invalid
 */
export function normalizeAdvertiserAccountInput(input = {}) {
  const email = normalizeAdvertiserEmail(input.email)
  if (!isLikelyEmail(email)) {
    throw new Error('A valid email is required.')
  }
  const password = typeof input.password === 'string' ? input.password : ''
  if (password.length < ADVERTISER_PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${ADVERTISER_PASSWORD_MIN_LENGTH} characters.`)
  }
  const companyName = typeof input.companyName === 'string' ? input.companyName.trim() : ''
  if (!companyName || companyName.length > COMPANY_NAME_MAX_LENGTH) {
    throw new Error(`Company name is required and must be ${COMPANY_NAME_MAX_LENGTH} characters or fewer.`)
  }
  const contactRaw = typeof input.contactName === 'string' ? input.contactName.trim() : ''
  return {
    email,
    password,
    companyName,
    contactName: contactRaw || null,
  }
}

/** Shape a DB advertiser row into the client-facing session payload (no hash). */
export function toAdvertiserProfile(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    companyName: row.company_name,
    contactName: row.contact_name || null,
    status: row.status,
  }
}
