import { isDeepStrictEqual } from 'node:util'

// A recording fake of the Supabase client for the feature-router tests (issue
// #191). The routers chain select / eq / is / in / order / range / limit /
// maybeSingle / single / insert / update / delete on a query and call rpc; this
// fake records every call as { method, args } and, when the query is awaited,
// answers from the table's handler with the recorded chain, so a test can
// assert both the answer and the filters that were applied:
//
//   const supabase = fakeSupabase({
//     lost_found_items: (chain) => (hasCall(chain, 'insert') ? { data: row, error: null } : { data: [], error: null }),
//     rpc: (name, args) => ({ data: 'joined', error: null }),
//   })
//   ...
//   const [list] = supabase.queriesOf('lost_found_items')
//   assert.ok(hasCall(list.chain, 'eq', 'user_id', 'u1'))
//
// A handler may return a promise; returning nothing answers { data: null,
// error: null }. A table with no handler throws, so a query the test did not
// expect fails loudly instead of reading as an empty result. Only the builder
// methods below exist, as on the real client, so a misspelt call throws too.

const BUILDER_METHODS = [
  // PostgrestQueryBuilder
  'select', 'insert', 'upsert', 'update', 'delete',
  // PostgrestFilterBuilder
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy',
  'match', 'not', 'or', 'filter', 'textSearch',
  // PostgrestTransformBuilder
  'order', 'limit', 'range', 'single', 'maybeSingle', 'abortSignal', 'returns',
]

function recordingQuery(chain, answer) {
  const query = {
    then(onFulfilled, onRejected) {
      return Promise.resolve()
        .then(() => answer(chain))
        .then((result) => result ?? { data: null, error: null })
        .then(onFulfilled, onRejected)
    },
  }
  for (const method of BUILDER_METHODS) {
    query[method] = (...args) => {
      chain.push({ method, args })
      return query
    }
  }
  return query
}

/**
 * @param {Record<string, (chain: Array<{ method: string, args: unknown[] }>) => unknown>} handlers
 *   one per table name, plus `rpc(name, args, chain)` for database functions
 */
export function fakeSupabase(handlers = {}) {
  /** Every query in the order it was built: { table, chain }. */
  const queries = []
  /** Every rpc call: { name, args, chain }. */
  const rpcCalls = []
  return {
    queries,
    rpcCalls,
    /** The queries against one table, oldest first. */
    queriesOf(table) {
      return queries.filter((q) => q.table === table)
    },
    from(table) {
      const chain = []
      queries.push({ table, chain })
      return recordingQuery(chain, (recorded) => {
        const handler = handlers[table]
        if (typeof handler !== 'function') throw new Error(`fakeSupabase: no handler for table "${table}"`)
        return handler(recorded)
      })
    },
    rpc(name, args) {
      const chain = []
      rpcCalls.push({ name, args, chain })
      return recordingQuery(chain, (recorded) => {
        if (typeof handlers.rpc !== 'function') throw new Error(`fakeSupabase: no rpc handler for "${name}"`)
        return handlers.rpc(name, args, recorded)
      })
    },
  }
}

/**
 * True when the chain holds a call to `method` whose leading arguments equal
 * `args` (deep equality). `hasCall(chain, 'eq', 'user_id')` matches any value.
 * @param {Array<{ method: string, args: unknown[] }>} chain
 * @param {string} method
 * @param {...unknown} args
 */
export function hasCall(chain, method, ...args) {
  return chain.some((call) => call.method === method && args.every((arg, i) => isDeepStrictEqual(call.args[i], arg)))
}

/**
 * The operation a chain starts with: 'select', 'insert', 'update', 'upsert'
 * or 'delete'. Handlers branch on it when one table sees a read and a write.
 * @param {Array<{ method: string, args: unknown[] }>} chain
 */
export function operation(chain) {
  return chain.find((call) => ['insert', 'upsert', 'update', 'delete'].includes(call.method))?.method
    ?? (chain.some((call) => call.method === 'select') ? 'select' : undefined)
}
