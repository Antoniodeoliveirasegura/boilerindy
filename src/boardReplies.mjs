// Inline reply previews for the board list route (issue #200). The route used to
// hand every reply it read straight to the client; now it shows the newest few
// per post and marks the threads that carry more, so the website can load the
// rest from GET /api/board/posts/:id/replies.

import { INLINE_REPLIES } from './boardLimits.mjs'

// created_at is an ISO timestamp from PostgREST. Compare as time rather than as
// text so a row written with a different UTC offset still sorts correctly; rows
// with an unreadable timestamp keep their input order (Array#sort is stable).
function byCreatedAt(a, b) {
  const at = Date.parse(a?.created_at ?? '')
  const bt = Date.parse(b?.created_at ?? '')
  if (Number.isNaN(at) || Number.isNaN(bt)) return 0
  return at - bt
}

/**
 * Bucket reply rows by post and keep only the newest `perPost` of each, oldest
 * first. Accepts the rows in any order, so the caller is free to read them
 * newest first to make its own LIMIT useful.
 *
 * @param {Array<{ post_id?: string, created_at?: string }>} replies rows as read
 * @param {{ perPost?: number }} [options] how many to keep per post
 * @returns {{ byPost: Record<string, object[]>, truncatedPostIds: string[] }}
 *   `byPost` holds the kept rows; `truncatedPostIds` names every post that had
 *   more than `perPost` replies in `replies`.
 */
export function groupRepliesByPost(replies, { perPost = INLINE_REPLIES } = {}) {
  const keep = Number.isInteger(perPost) && perPost >= 0 ? perPost : INLINE_REPLIES
  const byPost = {}
  const truncatedPostIds = []

  for (const reply of Array.isArray(replies) ? replies : []) {
    const postId = reply?.post_id
    if (!postId) continue
    if (!byPost[postId]) byPost[postId] = []
    byPost[postId].push(reply)
  }

  for (const postId of Object.keys(byPost)) {
    const group = byPost[postId].sort(byCreatedAt)
    if (group.length > keep) {
      truncatedPostIds.push(postId)
      byPost[postId] = group.slice(group.length - keep)
    }
  }

  return { byPost, truncatedPostIds }
}

/**
 * Shape one reply row the way both board routes return it.
 * @param {{ id: string, body: string, is_anon?: boolean, user_id?: string, created_at?: string }} reply
 * @param {Record<string, string>} nameMap display names by user id
 */
export function mapBoardReply(reply, nameMap = {}) {
  return {
    id: reply.id,
    body: reply.body,
    user: reply.is_anon ? 'Anonymous' : (nameMap[reply.user_id] || 'Student'),
    time: reply.created_at,
  }
}
