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
// posts only shows INLINE_REPLIES each, but PostgREST cannot LIMIT per post, so
// the budget is global and generous, 25 rows per post on the page. A page
// carrying a few busy threads can still spend it before every post is served;
// the route notices when the cap binds and leaves those posts marked, so they
// load their thread from GET /api/board/posts/:id/replies like any long one.
export const INLINE_REPLY_FETCH_LIMIT = BOARD_PAGE_SIZE * 25

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
