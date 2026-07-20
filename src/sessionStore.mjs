// Persistent session store backed by Supabase (issue #111).
//
// express-session defaults to MemoryStore, which lives in the Node process. On
// Render's free tier the service spins down after ~15 min idle, so every
// session died with it: a returning user whose cookie was still perfectly valid
// got bounced to /login and paid a full re-login on top of the ~50s cold start.
// Persisting sessions to Postgres makes the cookie meaningful again.
//
// Why a hand-rolled Store instead of connect-pg-simple: that needs a direct
// Postgres connection string (a new env var, plus Supabase pooler/IPv6 quirks
// on Render) and two new dependencies. The service-role Supabase client is
// already configured and already talks to the same database, so this reuses it.
// The Store interface we need is four methods.
//
// Session payload is tiny and fixed: { cookie, userId?, authAt?, advertiserId? }.
// Nothing here changes the auth call sites - regenerate/save/destroy keep
// working exactly as they do against MemoryStore.

import session from 'express-session'

export const SESSION_TABLE = 'user_sessions'

// `rolling: true` means express-session touches the session on EVERY response.
// Writing to Postgres that often would add a round-trip to every request, which
// is the opposite of what #111 is about. We only persist a touch when the last
// one for that sid was longer ago than this, so an active user costs one write
// per hour instead of one per request. The cost of the throttle is that the
// idle-expiry clock can lag by up to this much, immaterial against a 14-day
// cookie.
const TOUCH_THROTTLE_MS = 60 * 60 * 1000

// ponytail: in-process Map, so the throttle resets on restart (the first touch
// after a restart always writes, which is correct). Bounded by a size cap
// rather than per-entry expiry; swap for an LRU if session volume ever makes
// the periodic clear visible.
const MAX_TRACKED_SIDS = 5000

export function expiryFrom(sess) {
  const expires = sess?.cookie?.expires
  if (expires) {
    const parsed = new Date(expires)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const maxAge = sess?.cookie?.originalMaxAge ?? sess?.cookie?.maxAge
  if (typeof maxAge === 'number' && Number.isFinite(maxAge)) {
    return new Date(Date.now() + maxAge)
  }
  // No usable cookie expiry. Fall back to one day rather than writing a row
  // with no expiry that would never be reclaimed.
  return new Date(Date.now() + 24 * 60 * 60 * 1000)
}

export class SupabaseSessionStore extends session.Store {
  constructor(client, { tableName = SESSION_TABLE, touchThrottleMs = TOUCH_THROTTLE_MS } = {}) {
    super()
    this.client = client
    this.tableName = tableName
    this.touchThrottleMs = touchThrottleMs
    this.lastTouchedAt = new Map()
  }

  async get(sid, callback) {
    try {
      const { data, error } = await this.client
        .from(this.tableName)
        .select('sess, expire')
        .eq('sid', sid)
        .maybeSingle()

      if (error) return callback(error)
      if (!data) return callback(null, null)

      // Expired rows are dropped lazily on read, so a stale row can never be
      // handed back as a live session even if the sweep has not run.
      if (new Date(data.expire).getTime() <= Date.now()) {
        this.lastTouchedAt.delete(sid)
        await this.client.from(this.tableName).delete().eq('sid', sid)
        return callback(null, null)
      }

      const sess = typeof data.sess === 'string' ? JSON.parse(data.sess) : data.sess
      return callback(null, sess)
    } catch (err) {
      return callback(err)
    }
  }

  async set(sid, sess, callback) {
    try {
      const { error } = await this.client.from(this.tableName).upsert(
        {
          sid,
          sess,
          expire: expiryFrom(sess).toISOString(),
        },
        { onConflict: 'sid' },
      )
      if (error) return callback(error)
      this.#trackTouch(sid)
      return callback(null)
    } catch (err) {
      return callback(err)
    }
  }

  async destroy(sid, callback) {
    try {
      this.lastTouchedAt.delete(sid)
      const { error } = await this.client.from(this.tableName).delete().eq('sid', sid)
      return callback(error || null)
    } catch (err) {
      return callback(err)
    }
  }

  async touch(sid, sess, callback) {
    const last = this.lastTouchedAt.get(sid) ?? 0
    if (Date.now() - last < this.touchThrottleMs) return callback(null)

    try {
      const { error } = await this.client
        .from(this.tableName)
        .update({ expire: expiryFrom(sess).toISOString() })
        .eq('sid', sid)
      if (error) return callback(error)
      this.#trackTouch(sid)
      return callback(null)
    } catch (err) {
      return callback(err)
    }
  }

  #trackTouch(sid) {
    if (this.lastTouchedAt.size >= MAX_TRACKED_SIDS) this.lastTouchedAt.clear()
    this.lastTouchedAt.set(sid, Date.now())
  }
}

/**
 * Build the session store, or return null when the table is not migrated yet.
 *
 * The owner runs db/*.sql by hand, so a missing table must never be the reason
 * the app fails to boot. If `user_sessions` is unavailable we log loudly and
 * return null; the caller then leaves express-session on its MemoryStore
 * default, which is exactly today's behaviour. Same "inert and safe until
 * migrated" shape as the password_changed_at work in #132.
 *
 * @param {{ from: Function }} client - service-role Supabase client
 * @returns {Promise<SupabaseSessionStore|null>}
 */
export async function createSessionStore(client, { tableName = SESSION_TABLE } = {}) {
  try {
    const { error } = await client.from(tableName).select('sid').limit(1)
    if (error) {
      console.warn(
        `[session] ${tableName} is not available (${error.message}). ` +
          'Falling back to in-memory sessions: users will be signed out on every restart. ' +
          'Run db/supabase-sessions.sql to fix (issue #111).',
      )
      return null
    }
    return new SupabaseSessionStore(client, { tableName })
  } catch (err) {
    console.warn(`[session] could not reach ${tableName} (${err.message}). Using in-memory sessions.`)
    return null
  }
}
