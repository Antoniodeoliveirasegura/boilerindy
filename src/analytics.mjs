// First-party product analytics (issue #51) — functional core, mirroring
// advertiserAuth.mjs: pure validation with no I/O so it unit-tests without a
// live Supabase. server.mjs owns the insert into analytics_events
// (supabase-analytics.sql) and the opt-out/auth gating.

// Only allowlisted event names are ever stored. Add new events here (and
// document them in docs/analytics.md) rather than accepting free-form names —
// the allowlist is what keeps the table privacy-auditable.
export const ANALYTICS_EVENTS = [
  'page_view',
  'source_synced',
  'board_post_created',
  'assistant_message_sent',
  'dining_viewed',
  'transit_viewed',
  'task_completed',
  'deal_viewed',
  'deal_clicked',
]

export const ANALYTICS_BATCH_MAX = 20
const PAGE_MAX_LENGTH = 300
const PROPS_MAX_SERIALIZED_LENGTH = 2000

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizePage(page) {
  if (typeof page !== 'string') return null
  const trimmed = page.trim()
  if (!trimmed) return null
  return trimmed.slice(0, PAGE_MAX_LENGTH)
}

function normalizeProps(props) {
  if (!isPlainObject(props)) return {}
  let serialized
  try {
    serialized = JSON.stringify(props)
  } catch {
    throw new Error('Event props must be JSON-serializable.')
  }
  if (serialized.length > PROPS_MAX_SERIALIZED_LENGTH) {
    throw new Error(`Event props must serialize to at most ${PROPS_MAX_SERIALIZED_LENGTH} characters.`)
  }
  return props
}

/**
 * Validate and shape a client-submitted event batch.
 * @param {{ events?: Array<{ event_name?: string, page?: string, props?: object }> }} input
 * @returns {Array<{ event_name: string, page: string|null, props: object }>}
 * @throws {Error} with a user-facing message when the batch is invalid
 */
export function normalizeAnalyticsBatch(input = {}) {
  const events = input.events
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Send a non-empty events array.')
  }
  if (events.length > ANALYTICS_BATCH_MAX) {
    throw new Error(`Send at most ${ANALYTICS_BATCH_MAX} events per request.`)
  }

  return events.map((event) => {
    const name = typeof event?.event_name === 'string' ? event.event_name : ''
    if (!ANALYTICS_EVENTS.includes(name)) {
      throw new Error('Unknown analytics event name.')
    }
    return {
      event_name: name,
      page: normalizePage(event.page),
      props: normalizeProps(event.props),
    }
  })
}
