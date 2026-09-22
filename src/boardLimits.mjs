// Campus board limits (issue #200). The board capped the title at 300 characters
// and then accepted a body and a reply of any length, and the list route read
// every live post and every reply attached to them in one go. The caps and the
// page sizes live here so the routes in server.mjs and the website enforce the
// same numbers; boilerindy-react imports this module directly.

export const MAX_BOARD_TITLE = 300
export const MAX_BOARD_BODY = 5000
export const MAX_BOARD_REPLY = 2000

export const BOARD_PAGE_SIZE = 20
export const INLINE_REPLIES = 5
export const REPLY_PAGE_SIZE = 50

// Reply rows the list route will read to build the inline previews. One page of
// posts shows at most BOARD_PAGE_SIZE * INLINE_REPLIES of them, and PostgREST
// cannot LIMIT per post, so the cap is global with headroom: a page carrying a
// few busy threads still previews the quiet ones. A post the cap starves keeps
// its real reply count and loads its thread from GET /api/board/posts/:id/replies.
export const INLINE_REPLY_FETCH_LIMIT = BOARD_PAGE_SIZE * INLINE_REPLIES * 2

const text = (value) => String(value ?? '').trim()

/**
 * Check a new or edited board post.
 * @param {{ title?: unknown, body?: unknown }} input untrimmed request fields
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateBoardPost({ title, body } = {}) {
  const t = text(title)
  if (!t) return { ok: false, message: 'Title is required.' }
  if (t.length > MAX_BOARD_TITLE) {
    return { ok: false, message: `Title must be ${MAX_BOARD_TITLE} characters or fewer.` }
  }
  if (text(body).length > MAX_BOARD_BODY) {
    return { ok: false, message: `Details must be ${MAX_BOARD_BODY} characters or fewer.` }
  }
  return { ok: true }
}

/**
 * Check a reply body.
 * @param {{ body?: unknown }} input untrimmed request fields
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateBoardReply({ body } = {}) {
  const b = text(body)
  if (!b) return { ok: false, message: 'Reply body is required.' }
  if (b.length > MAX_BOARD_REPLY) {
    return { ok: false, message: `Reply must be ${MAX_BOARD_REPLY} characters or fewer.` }
  }
  return { ok: true }
}
