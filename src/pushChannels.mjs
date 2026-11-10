// The push channels of an account: its browsers (push_subscriptions) and its
// phones (push_devices). A channel belongs to the account, not to the session
// that registered it, so it outlived the sessions a password change ends
// (#132): whoever held a stolen session could register an endpoint or Expo
// token of their own and keep receiving the student's reminders, due dates
// and alerts after the password changed. A password change now ends every
// channel too, as it ends every other session. The browser that made the
// change registers itself again once the change succeeds
// (reregisterThisDevice in boilerindy-react/src/lib/push.ts), and the phone
// app registers again on its next launch, which restores a row the server
// dropped.

import { isSchemaMissingError } from './dbErrors.mjs'

export const PUSH_CHANNEL_TABLES = ['push_subscriptions', 'push_devices']

/**
 * Deletes every push channel of the account. It never throws: the password has
 * already changed when this runs, so a failure is logged and the change still
 * succeeds. A table that is not installed yet has nothing to delete.
 *
 * @param {object} supabase the Supabase client
 * @param {string} userId users.id, the column both tables key on
 * @returns {Promise<Record<string, number>>} rows deleted, per table
 */
export async function forgetPushChannels(supabase, userId) {
  const removed = {}
  for (const table of PUSH_CHANNEL_TABLES) {
    removed[table] = 0
    try {
      const { data, error } = await supabase.from(table).delete().eq('user_id', userId).select('id')
      if (error) throw error
      removed[table] = (data || []).length
    } catch (error) {
      if (!isSchemaMissingError(error)) {
        console.error(`[forgetPushChannels] ${table} not cleared for user=${userId}:`, error?.message || error)
      }
    }
  }
  return removed
}
