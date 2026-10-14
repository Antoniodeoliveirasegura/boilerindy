import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { boardDraftKey, boardReplyDraftKey } from '../lib/aiInsightCache'
import { track } from '../lib/usageStats'
import AiMarkdown from '../components/AiMarkdown'
import Icon from '../components/Icons'
import { useConfirm } from '../hooks/useConfirm'
import { useReportAndBlock } from '../hooks/useReportAndBlock'
// Same caps and page sizes the API enforces (issue #200)
import {
  MAX_BOARD_TITLE,
  MAX_BOARD_BODY,
  MAX_BOARD_REPLY,
} from '../../../src/boardLimits.mjs'
import PageTitle from '../components/PageTitle'

type Reply = { id?: string; user?: string; body?: string; time?: string; anon?: boolean; isMine?: boolean; [key: string]: unknown }
type Post = {
  id: string
  title?: string
  body?: string
  time?: string
  editedTime?: string | null
  anon?: boolean
  isMine?: boolean
  upvotes?: number
  upvotedByMe?: boolean
  pinned?: boolean
  hot?: boolean
  user?: string
  tags?: string[]
  replies: Reply[]
  replyCount?: number
  hasMoreReplies?: boolean
  [key: string]: unknown
}
type LiveCompose = { betterTitle?: string; bodyAddOn?: string; tags?: string[] }
type BoardPage = { posts?: Post[]; page?: number; hasMore?: boolean }

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

// Report and Block author on someone else's post or reply (issue #192). An
// anonymous one is reported only: the Blocked users list names everyone on it,
// so blocking its author would unmask them (owner decision, 2026-09-27). Only
// an explicit anon: false offers the block.
function canBlockAuthor(item: { isMine?: boolean; anon?: boolean }) {
  return !item.isMine && item.anon === false
}

export default function Board() {
  const { user } = useAuth()
  const userId = user?.id as string | undefined
  const { confirm, confirmDialog } = useConfirm()
  const { report, blockAuthor, moderationUi } = useReportAndBlock()
  const [posts, setPosts] = useState<Post[]>([])
  const [sort, setSort] = useState('recent')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Threads holding an unsent reply open again on return, so the draft shows.
  const [repliesOpen, setRepliesOpen] = useState<Set<string>>(() => new Set(postIdsWithReplyDrafts(userId)))
  // The list route serves one page of posts with a few replies previewed per
  // post (issue #200); the rest of each thread comes from its own route.
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [replyPages, setReplyPages] = useState<Record<string, number>>({})
  const [loadingReplies, setLoadingReplies] = useState<Set<string>>(new Set())
  // Drafts survive session-expiry redirects to /login (issue #23), per user so
  // the next account on a shared computer never sees them (issue #219)
  const [showForm, setShowForm] = useState(() => {
    const draft = loadBoardDraft(userId)
    return Boolean(draft.title || draft.body)
  })
  const [newTitle, setNewTitle] = useState(() => loadBoardDraft(userId).title)
  const [newBody, setNewBody] = useState(() => loadBoardDraft(userId).body)
  const [isAnon, setIsAnon] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [improving, setImproving] = useState(false)
  const [postError, setPostError] = useState('')
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState('')
  const [liveCompose, setLiveCompose] = useState<LiveCompose | null>(null)
  const [liveComposeLoading, setLiveComposeLoading] = useState(false)

  const handleImprovePost = async () => {
    if (!newTitle.trim() || improving) return
    setImproving(true)
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: `Improve this campus board post to be clearer and more likely to get helpful responses. Keep the same question intent. Return ONLY the improved title on the first line, then a blank line, then the improved body (or nothing if no body needed). No explanations.\n\nTitle: ${newTitle}\nBody: ${newBody}`,
          }],
        }),
      })
      const data = (await res.json()) as { reply?: string }
      if (data.reply) {
        const lines = data.reply.trim().split('\n')
        const title = lines[0].replace(/^(Title:\s*|#+\s*)/i, '').trim()
        const bodyLines = lines.slice(1).filter((l, i) => i > 0 || l.trim())
        const body = bodyLines.join('\n').replace(/^(Body:\s*)/i, '').trim()
        if (title) setNewTitle(title)
        if (body) setNewBody(body)
      }
    } catch (err) {
      console.error('Improve post error', err)
    } finally {
      setImproving(false)
    }
  }
  // ── Fetch posts ────────────────────────────────────────────────────────────
  const fetchPosts = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setLoading(true)
      const data = (await authRequest(`/api/board/posts?sort=${sort}&page=0`)) as BoardPage
      setPosts((data.posts || []).map(withRelativeTimes))
      setPage(0)
      setHasMore(Boolean(data.hasMore))
      setReplyPages({})
    } catch (err) {
      console.error('Board fetch error', err)
      if (!silent) {
        setPosts([])
        setHasMore(false)
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [sort])

  const loadMorePosts = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const next = page + 1
    try {
      const data = (await authRequest(`/api/board/posts?sort=${sort}&page=${next}`)) as BoardPage
      const incoming = (data.posts || []).map(withRelativeTimes)
      // A post published while you were reading shifts the window, so drop any
      // id already on screen rather than showing it twice.
      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id))
        return [...prev, ...incoming.filter((p) => !seen.has(p.id))]
      })
      setPage(next)
      setHasMore(Boolean(data.hasMore))
    } catch (err) {
      console.error('Board load more error', err)
    } finally {
      setLoadingMore(false)
    }
  }

  // ── Load the rest of one thread (issue #200) ───────────────────────────────
  const loadThreadReplies = async (postId: string) => {
    if (loadingReplies.has(postId)) return
    const loaded = replyPages[postId]
    const first = loaded === undefined
    const next = first ? 0 : loaded + 1
    setLoadingReplies((prev) => new Set(prev).add(postId))
    try {
      const data = (await authRequest(`/api/board/posts/${postId}/replies?page=${next}`)) as {
        replies?: Reply[]
        hasMore?: boolean
      }
      const incoming = (data.replies || []).map((r) => ({ ...r, time: formatRelative(r.time) }))
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            // Page 0 replaces the preview; later pages append to it.
            ? { ...p, replies: dedupeReplies(first ? incoming : [...p.replies, ...incoming]), hasMoreReplies: Boolean(data.hasMore) }
            : p,
        ),
      )
      setReplyPages((prev) => ({ ...prev, [postId]: next }))
    } catch (err) {
      console.error('Board replies fetch error', err)
    } finally {
      setLoadingReplies((prev) => { const n = new Set(prev); n.delete(postId); return n })
    }
  }

  useEffect(() => {
    // fetchPosts performs its setState after an await; wrap it in an IIFE so the
    // effect body has no synchronous setState call. `loading` already starts true
    // for the initial load; on sort changes fetchPosts re-runs and shows the
    // loading state, which is intended.
    void (async () => {
      await fetchPosts()
    })()
  }, [fetchPosts])

  useEffect(() => {
    saveBoardDraft(userId, newTitle, newBody)
  }, [userId, newTitle, newBody])

  // ── Live AI suggestions (debounced) while composing ─────────────────────
  useEffect(() => {
    let cancelled = false
    /* eslint-disable react-hooks/set-state-in-effect --
       Intentional synchronous UI sync: clear stale AI compose suggestions the
       moment the composer closes or the draft becomes too short, and flag loading
       before the debounced request. These are cleanup resets, not derived state. */
    if (!showForm) {
      setLiveCompose(null)
      setLiveComposeLoading(false)
      return
    }
    const t = newTitle.trim()
    const b = newBody.trim()
    if (t.length < 6 && b.length < 20) {
      setLiveCompose(null)
      setLiveComposeLoading(false)
      return
    }
    const ac = new AbortController()
    setLiveComposeLoading(true)
    /* eslint-enable react-hooks/set-state-in-effect */
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/board/ai-suggestions', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: 'compose', title: t, body: b }),
          signal: ac.signal,
        })
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setLiveCompose(null)
          return
        }
        const has =
          (data.betterTitle && String(data.betterTitle).trim()) ||
          (data.bodyAddOn && String(data.bodyAddOn).trim()) ||
          (Array.isArray(data.tags) && data.tags.length > 0)
        setLiveCompose(has ? (data as LiveCompose) : null)
      } catch (e) {
        if ((e as { name?: string })?.name !== 'AbortError' && !cancelled) setLiveCompose(null)
      } finally {
        if (!cancelled) setLiveComposeLoading(false)
      }
    }, 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
      ac.abort()
    }
  }, [newTitle, newBody, showForm])

  // ── Upvote ─────────────────────────────────────────────────────────────────
  const handleUpvote = async (id: string) => {
    // Optimistic update
    setPosts(prev => prev.map(p =>
      p.id === id
        ? { ...p, upvotes: p.upvotedByMe ? (p.upvotes ?? 0) - 1 : (p.upvotes ?? 0) + 1, upvotedByMe: !p.upvotedByMe }
        : p
    ))
    try {
      const data = (await authRequest(`/api/board/posts/${id}/upvote`, { method: 'POST' })) as { upvotes?: number; upvotedByMe?: boolean }
      setPosts(prev => prev.map(p =>
        p.id === id ? { ...p, upvotes: data.upvotes, upvotedByMe: data.upvotedByMe } : p
      ))
    } catch {
      // Revert
      setPosts(prev => prev.map(p =>
        p.id === id
          ? { ...p, upvotes: p.upvotedByMe ? (p.upvotes ?? 0) - 1 : (p.upvotes ?? 0) + 1, upvotedByMe: !p.upvotedByMe }
          : p
      ))
    }
  }

  const toggleExpand  = (id: string) => setExpanded(prev => toggle(prev, id))
  const toggleReplies = (id: string) => setRepliesOpen(prev => toggle(prev, id))

  const handleDeletePost = async (id: string) => {
    if (
      !(await confirm({
        title: 'Delete this post?',
        message: 'This removes your post and its replies from the board.',
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    ) {
      return
    }
    setDeletingId(id)
    try {
      await authRequest(`/api/board/posts/${id}`, { method: 'DELETE' })
      setPosts((prev) => prev.filter((p) => p.id !== id))
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setRepliesOpen((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    } catch (err) {
      console.error('Delete post error', err)
      window.alert(errorText(err, 'Could not delete this post.'))
    } finally {
      setDeletingId(null)
    }
  }

  // A blocked author's posts and replies leave the board, so it is read again.
  const handleBlockAuthor = async (targetType: 'board_post' | 'board_reply', id: string) => {
    if (await blockAuthor(targetType, id)) await fetchPosts({ silent: true })
  }

  // ── Edit post (issue #7) ───────────────────────────────────────────────────
  const startEditPost = (post: Post) => {
    setEditingId(post.id)
    setEditTitle(post.title ?? '')
    setEditBody(post.body || '')
    setEditError('')
  }

  const cancelEditPost = () => {
    setEditingId(null)
    setEditTitle('')
    setEditBody('')
    setEditError('')
  }

  const handleSaveEdit = async (id: string) => {
    if (!editTitle.trim() || savingEdit) return
    setSavingEdit(true)
    setEditError('')
    try {
      const data = (await authRequest(`/api/board/posts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: editTitle.trim(), body: editBody.trim() }),
      })) as { post: { title?: string; body?: string } }
      setPosts((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, title: data.post.title, body: data.post.body, editedTime: 'Just now' }
            : p,
        ),
      )
      cancelEditPost()
    } catch (err) {
      console.error('Edit post error', err)
      setEditError(errorText(err, 'Could not save your changes. Try again.'))
    } finally {
      setSavingEdit(false)
    }
  }

  // ── Submit post ────────────────────────────────────────────────────────────
  const handleSubmitPost = async () => {
    if (!newTitle.trim() || submitting) return
    setSubmitting(true)
    setPostError('')
    try {
      await authRequest('/api/board/posts', {
        method: 'POST',
        body: JSON.stringify({ title: newTitle.trim(), body: newBody.trim(), anon: isAnon }),
      })
      track('board_post_created')
      setNewTitle('')
      setNewBody('')
      saveBoardDraft(userId, '', '')
      setLiveCompose(null)
      setShowForm(false)
      setFilterTag(null)
      await fetchPosts({ silent: true })
    } catch (err) {
      console.error('Post submit error', err)
      setPostError(errorText(err, 'Could not publish your post. Try again.'))
    } finally {
      setSubmitting(false)
    }
  }

  // ── Submit reply ───────────────────────────────────────────────────────────
  const handleSubmitReply = async (postId: string, text: string) => {
    if (!text.trim()) return
    const data = (await authRequest(`/api/board/posts/${postId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body: text, anon: false }),
    })) as { reply: Reply }
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? {
              ...p,
              replies: [...p.replies, { ...data.reply, time: 'Just now' }],
              replyCount: (p.replyCount ?? p.replies.length) + 1,
            }
          : p,
      ),
    )
  }

  const [threadSummaries, setThreadSummaries] = useState<Record<string, string>>({})
  const [summarizing, setSummarizing] = useState<Set<string>>(new Set())

  const summarizeThread = async (post: Post) => {
    if (summarizing.has(post.id)) return
    setSummarizing((prev) => new Set(prev).add(post.id))
    try {
      const threadText = [
        `Title: ${post.title}`,
        post.body ? `Post: ${post.body}` : '',
        ...post.replies.map((r, i) => `Reply ${i + 1} (${r.user}): ${r.body}`),
      ].filter(Boolean).join('\n').slice(0, 2000)

      const res = await fetch('/api/assistant', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: `Summarize this campus board discussion in 2-3 concise "-" bullets. What is the main question and what are the key answers or opinions? No headings, no intro line.\n\n${threadText}`,
          }],
        }),
      })
      const data = await res.json()
      if (data.reply) {
        setThreadSummaries((prev) => ({ ...prev, [post.id]: data.reply }))
      }
    } catch (err) {
      console.error('Summarize thread error', err)
    } finally {
      setSummarizing((prev) => { const n = new Set(prev); n.delete(post.id); return n })
    }
  }

  const allTags = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of posts) {
      for (const t of p.tags || []) {
        counts[t] = (counts[t] || 0) + 1
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }))
  }, [posts])

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const sortedPosts = [...posts]
    .filter((p) => !filterTag || (p.tags || []).includes(filterTag))
    .filter((p) => {
      if (!normalizedQuery) return true
      const haystack = [p.title, p.body, ...(p.tags || [])].join(' ').toLowerCase()
      return haystack.includes(normalizedQuery)
    })
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return sort === 'popular' ? (b.upvotes ?? 0) - (a.upvotes ?? 0) : 0
    })

  return (
    <div className="page r-ink">
      <div className="page-measure">
        <PageTitle>Campus Board</PageTitle>
        {confirmDialog}
        {moderationUi}
        <header className="page-head">
          <div>
            <h1 className="page-title">Campus Board</h1>
            <p className="page-sub">
              Ask questions, share tips, and help each other navigate Purdue Indianapolis.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowForm(!showForm)
              if (showForm) setPostError('')
            }}
            className={`btn shrink-0 ${showForm ? 'btn-secondary' : 'btn-primary'}`}
          >
            <Icon name={showForm ? 'close' : 'plus'} size={16} />
            {showForm ? 'Close' : 'New question'}
          </button>
        </header>

        {/* Compose - scrollable so Post is never clipped on small viewports */}
        <div
          className={`transition-opacity duration-150 ${
            showForm ? 'max-h-[min(85vh,720px)] opacity-100 mb-6 overflow-y-auto overscroll-contain' : 'max-h-0 opacity-0 mb-0 overflow-hidden pointer-events-none'
          }`}
        >
          <div className="card card-pad">
            <div className="card-head">
              <span className="route-badge" aria-hidden="true">
                <Icon name="edit" size={18} />
              </span>
              <span className="card-title">Compose</span>
            </div>
            {postError && (
              <div
                role="alert"
                className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/8 px-4 py-3 text-[13px] text-[var(--color-error)]"
              >
                {postError}
              </div>
            )}
            <label className="sr-only" htmlFor="board-new-title">
              Question title
            </label>
            <div className="mb-3">
              <input
                id="board-new-title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                maxLength={MAX_BOARD_TITLE}
                placeholder="What do you want to ask campus?"
                className="input text-[15px] font-medium"
              />
              <CharCount value={newTitle} max={MAX_BOARD_TITLE} />
            </div>
            <label className="sr-only" htmlFor="board-new-body">
              Optional details
            </label>
            <div className="mb-4">
              <textarea
                id="board-new-body"
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                maxLength={MAX_BOARD_BODY}
                placeholder="Optional context - course, building, deadline…"
                className="input text-[14px] resize-y min-h-[108px]"
              />
              <CharCount value={newBody} max={MAX_BOARD_BODY} />
            </div>

            {(liveComposeLoading || liveCompose) && (
              <div className="r-ai mb-5 rounded-[var(--radius-lg)] bg-[var(--color-stat)] px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="route-badge sm" aria-hidden="true">
                    <Icon name="sparkles" size={14} />
                  </span>
                  <span className="eyebrow bare">Live suggestions</span>
                  {liveComposeLoading && (
                    <span className="text-[12px] text-[var(--color-txt-3)] ml-auto">Updating…</span>
                  )}
                </div>
                {liveComposeLoading && !liveCompose && (
                  <p className="text-[13px] text-[var(--color-txt-2)] mt-2.5">Checking title, details, and tags…</p>
                )}
                {liveCompose?.betterTitle && (
                  <div className="mt-3 pt-3 border-t border-[var(--color-border-2)]">
                    <p className="font-display font-bold text-[12px] text-[var(--color-txt-2)] mb-1">
                      Clearer title
                    </p>
                    <p className="text-[14px] text-[var(--color-txt-0)] leading-snug mb-1.5">{liveCompose.betterTitle}</p>
                    <button
                      type="button"
                      onClick={() => setNewTitle(liveCompose?.betterTitle ?? '')}
                      className="link-btn"
                    >
                      Use this title
                    </button>
                  </div>
                )}
                {liveCompose?.bodyAddOn && (
                  <div className="mt-3 pt-3 border-t border-[var(--color-border-2)]">
                    <p className="font-display font-bold text-[12px] text-[var(--color-txt-2)] mb-1">
                      Add context
                    </p>
                    <p className="text-[14px] text-[var(--color-txt-0)] leading-snug mb-1.5">{liveCompose.bodyAddOn}</p>
                    <button
                      type="button"
                      onClick={() =>
                        setNewBody((prev: string) => {
                          const add = (liveCompose?.bodyAddOn ?? '').trim()
                          if (!prev.trim()) return add
                          return `${prev.trim()}\n\n${add}`
                        })
                      }
                      className="link-btn"
                    >
                      Append to details
                    </button>
                  </div>
                )}
                {(liveCompose?.tags?.length ?? 0) > 0 && (
                  <div className="mt-3 pt-3 border-t border-[var(--color-border-2)]">
                    <p className="font-display font-bold text-[12px] text-[var(--color-txt-2)] mb-1.5">
                      Likely tags after you post
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {(liveCompose?.tags || []).map((tag) => (
                        <span key={tag} className="chip bg-[var(--color-surface)]">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <label className="flex items-center gap-3 text-[14px] text-[var(--color-txt-1)] cursor-pointer select-none group">
                <div
                  role="checkbox"
                  aria-checked={isAnon}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setIsAnon((v) => !v)}
                  className={`w-5 h-5 rounded-[var(--radius-sm)] border-[1.5px] flex items-center justify-center transition-colors shrink-0 ${
                    isAnon
                      ? 'bg-[var(--color-txt-0)] border-[var(--color-txt-0)]'
                      : 'border-[var(--color-border-3)] bg-[var(--color-surface)] group-hover:border-[var(--color-txt-1)]'
                  }`}
                  onClick={() => setIsAnon((v) => !v)}
                >
                  {isAnon && <Icon name="check" size={12} className="text-[var(--color-surface)]" strokeWidth={3} />}
                </div>
                <input
                  type="checkbox"
                  checked={isAnon}
                  onChange={(e) => setIsAnon(e.target.checked)}
                  className="sr-only"
                />
                <span>Post anonymously</span>
              </label>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <button
                  type="button"
                  onClick={handleImprovePost}
                  disabled={!newTitle.trim() || improving}
                  className="btn btn-secondary"
                  title="Let AI rewrite your post to be clearer"
                >
                  <Icon name="sparkles" size={15} />
                  {improving ? 'Improving…' : 'Polish with AI'}
                </button>
                <button
                  type="button"
                  onClick={handleSubmitPost}
                  disabled={!newTitle.trim() || submitting}
                  className="btn btn-primary"
                >
                  {submitting ? 'Posting…' : 'Post'}
                  <Icon name="send" size={15} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Toolbar: the sort pills and the thread count, then the search
            (issue #5), in the same row as the Marketplace and Lost and Found
            filters: right of the pills from lg, full width under them below. */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex gap-2">
            {['recent', 'popular'].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                aria-pressed={sort === s}
                className={`pill capitalize ${sort === s ? 'pill-active' : ''}`}
              >
                {s}
              </button>
            ))}
          </div>
          <span className="max-lg:ml-auto font-display font-bold text-[13px] text-[var(--color-txt-2)] tnum">
            {sortedPosts.length} {sortedPosts.length === 1 ? 'thread' : 'threads'}
          </span>
          <div className="relative w-full lg:w-[360px] lg:ml-auto">
            <Icon
              name="search"
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-txt-2)] pointer-events-none"
            />
            <label className="sr-only" htmlFor="board-search">
              Search board posts
            </label>
            {/* Phones keep the typed text at 16px (no iOS zoom) and set the
                long placeholder at 14px, ending in an ellipsis if it is cut. */}
            <input
              id="board-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search threads by title, details, or tag…"
              className={`input pl-10 text-ellipsis max-md:placeholder:text-[14px] lg:min-h-[40px] lg:py-2 ${searchQuery ? 'pr-11' : ''}`}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="icon-btn absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9"
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        </div>

        {allTags.length > 0 && (
          <div className="flex gap-2 mb-5 overflow-x-auto scrollbar-hide -mx-1 px-1 py-1 max-md:-mx-4 max-md:px-4 max-md:[mask-image:linear-gradient(to_right,#000_88%,transparent)]">
            <button
              type="button"
              onClick={() => setFilterTag(null)}
              className={`pill shrink-0 ${!filterTag ? 'pill-active' : ''}`}
            >
              All topics
            </button>
            {allTags.map(({ tag, count }) => (
              <button
                key={tag}
                type="button"
                onClick={() => setFilterTag(filterTag === tag ? null : tag)}
                className={`pill shrink-0 ${filterTag === tag ? 'pill-active' : ''}`}
              >
                #{tag}
                <span className="tnum font-semibold opacity-70">{count}</span>
              </button>
            ))}
          </div>
        )}

        {loading && (
          <div className="card card-pad flex items-center gap-3.5">
            <span
              className="w-6 h-6 shrink-0 rounded-full border-2 border-[var(--color-border-2)] border-t-[var(--color-txt-0)] animate-spin"
              aria-hidden="true"
            />
            <div>
              <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">Loading threads…</p>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-0.5">Hang tight</p>
            </div>
          </div>
        )}

        {!loading && (
          <div>
            {sortedPosts.length > 0 && (
              <div className="card posts px-5 max-sm:px-4">
                {sortedPosts.map((post) => (
                  <article
                    key={post.id}
                    className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3.5 py-4 border-t border-[var(--color-border)] first:border-t-0"
                  >
                    <span className="ava mt-0.5">
                      {(post.user ?? '').charAt(0).toUpperCase()}
                    </span>

                    <div className="min-w-0">
                      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:gap-4">
                        <div className="min-w-0 flex-1">
                          {(post.pinned || (Boolean(post.hot) && !post.pinned)) && (
                            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                              {post.pinned && (
                                <span className="badge">
                                  <Icon name="pin" size={10} />
                                  Pinned
                                </span>
                              )}
                              {Boolean(post.hot) && !post.pinned && (
                                <span className="badge">
                                  Trending
                                </span>
                              )}
                            </div>
                          )}

                          {editingId === post.id ? (
                            <div>
                              <label className="sr-only" htmlFor={`edit-title-${post.id}`}>
                                Edit title
                              </label>
                              <div className="mb-2">
                                <input
                                  id={`edit-title-${post.id}`}
                                  value={editTitle}
                                  onChange={(e) => setEditTitle(e.target.value)}
                                  maxLength={MAX_BOARD_TITLE}
                                  className="input text-[15px] font-medium"
                                />
                                <CharCount value={editTitle} max={MAX_BOARD_TITLE} />
                              </div>
                              <label className="sr-only" htmlFor={`edit-body-${post.id}`}>
                                Edit details
                              </label>
                              <textarea
                                id={`edit-body-${post.id}`}
                                value={editBody}
                                onChange={(e) => setEditBody(e.target.value)}
                                maxLength={MAX_BOARD_BODY}
                                placeholder="Optional context - course, building, deadline…"
                                className="input text-[14px] resize-y min-h-[88px]"
                              />
                              <CharCount value={editBody} max={MAX_BOARD_BODY} />
                              {editError && (
                                <p className="text-[13px] text-[var(--color-error)] mt-2" role="alert">
                                  {editError}
                                </p>
                              )}
                              <div className="flex items-center gap-2 mt-3">
                                <button
                                  type="button"
                                  onClick={() => handleSaveEdit(post.id)}
                                  disabled={!editTitle.trim() || savingEdit}
                                  className="btn btn-ink btn-sm"
                                >
                                  {savingEdit ? 'Saving…' : 'Save changes'}
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEditPost}
                                  className="btn btn-secondary btn-sm"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleExpand(post.id)}
                              className="ttl group w-full text-left"
                            >
                              <span className="group-hover:underline underline-offset-[3px] decoration-2">{post.title}</span>
                              {post.body ? (
                                <span className="block font-sans text-[12.5px] font-normal text-[var(--color-txt-3)] mt-1">
                                  {expanded.has(post.id) ? 'Tap to collapse' : 'Tap to read more'}
                                </span>
                              ) : null}
                            </button>
                          )}

                          <div className="by flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5">
                            <span className="font-semibold text-[var(--color-txt-1)]">{post.user}</span>
                            <span>·</span>
                            <span>{post.time}</span>
                            {post.editedTime && (
                              <span className="italic text-[var(--color-txt-3)]" title="This post was edited by its author">
                                edited {post.editedTime}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="counts shrink-0">
                          <button
                            type="button"
                            onClick={() => handleUpvote(post.id)}
                            aria-pressed={post.upvotedByMe}
                            className={`max-md:h-10 transition-colors ${
                              post.upvotedByMe
                                ? 'bg-[var(--color-txt-0)] text-[var(--color-surface)]'
                                : 'hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)]'
                            }`}
                          >
                            <Icon name="chevronUp" size={15} strokeWidth={2.5} />
                            <span className="tnum">{post.upvotes}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleReplies(post.id)}
                            aria-expanded={repliesOpen.has(post.id)}
                            className={`max-md:h-10 transition-colors hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] ${
                              repliesOpen.has(post.id) ? 'shadow-[inset_0_0_0_1.5px_var(--color-txt-0)] text-[var(--color-txt-0)]' : ''
                            }`}
                          >
                            <Icon name="message" size={14} />
                            {replyCountOf(post)} {replyCountOf(post) === 1 ? 'reply' : 'replies'}
                          </button>
                        </div>
                      </div>

                      {editingId !== post.id && (post.tags?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {(post.tags || []).map((tag) => (
                            <span key={tag} className="chip">
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}

                      <div
                        className={`grid ${
                          expanded.has(post.id) && post.body && editingId !== post.id ? 'grid-rows-[1fr] mt-3' : 'grid-rows-[0fr]'
                        }`}
                      >
                        <div className="overflow-hidden min-h-0">
                          <p className="text-[15px] text-[var(--color-txt-1)] leading-relaxed pr-1 [overflow-wrap:anywhere]">{post.body}</p>
                        </div>
                      </div>

                      {/* The post's actions line, the last line of its text block (under
                          the tags and the opened body): Edit and Delete on your own
                          post, Report and Block author on anyone else's. */}
                      <div className="mod-actions">
                        {post.isMine && editingId !== post.id && (
                          <button
                            type="button"
                            onClick={() => startEditPost(post)}
                            className="font-bold text-[var(--color-accent)] hover:underline underline-offset-[3px]"
                          >
                            <Icon name="edit" size={13} />
                            Edit
                          </button>
                        )}
                        {post.isMine && (
                          <button
                            type="button"
                            onClick={() => handleDeletePost(post.id)}
                            disabled={deletingId === post.id}
                            className="font-bold text-[var(--color-error)] hover:underline underline-offset-[3px] disabled:opacity-50"
                          >
                            <Icon name="trash" size={13} />
                            {deletingId === post.id ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                        {!post.isMine && (
                          <button
                            type="button"
                            onClick={(e) => report({ targetType: 'board_post', targetId: post.id, targetLabel: 'this post' }, e.currentTarget)}
                          >
                            <Icon name="flag" size={13} />
                            Report
                          </button>
                        )}
                        {canBlockAuthor(post) && (
                          <button type="button" onClick={() => void handleBlockAuthor('board_post', post.id)}>
                            Block author
                          </button>
                        )}
                      </div>

                      <div
                        className={`grid ${
                          repliesOpen.has(post.id) ? 'grid-rows-[1fr] mt-3' : 'grid-rows-[0fr]'
                        }`}
                      >
                        <div className="overflow-hidden min-h-0">
                          <div className="border-l-2 border-[var(--color-border-2)] pl-4 pr-1 pb-1">
                            {replyCountOf(post) >= 5 && (
                              <div className="pt-1 mb-2">
                                {threadSummaries[post.id] ? (
                                  <div className="r-ai rounded-[var(--radius-lg)] bg-[var(--color-stat)] px-4 py-3.5">
                                    <div className="flex items-center gap-2.5 mb-2">
                                      <span className="route-badge sm" aria-hidden="true">
                                        <Icon name="sparkles" size={14} />
                                      </span>
                                      <span className="eyebrow bare">
                                        Thread summary
                                      </span>
                                    </div>
                                    <AiMarkdown className="text-[14px] text-[var(--color-txt-1)]">
                                      {threadSummaries[post.id]}
                                    </AiMarkdown>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => summarizeThread(post)}
                                    disabled={summarizing.has(post.id)}
                                    className="btn btn-secondary btn-sm"
                                  >
                                    <Icon name="sparkles" size={14} />
                                    {summarizing.has(post.id) ? 'Summarizing…' : 'Summarize long thread'}
                                  </button>
                                )}
                              </div>
                            )}
                            <ul>
                              {post.replies.map((reply, i) => (
                                <li
                                  key={reply.id ?? i}
                                  className="py-3 border-t border-[var(--color-border)] first:border-t-0"
                                >
                                  <p className="text-[14px] text-[var(--color-txt-1)] leading-relaxed [overflow-wrap:anywhere]">{reply.body}</p>
                                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[12px] text-[var(--color-txt-2)]">
                                    <span className="ava w-6 h-6 text-[10px]">
                                      {(reply.user ?? '').charAt(0).toUpperCase()}
                                    </span>
                                    <span className="font-semibold text-[var(--color-txt-1)]">{reply.user}</span>
                                    <span>·</span>
                                    <span>{reply.time}</span>
                                  </div>
                                  {reply.id && !reply.isMine && (
                                    <div className="mod-actions">
                                      <button
                                        type="button"
                                        onClick={(e) =>
                                          report({ targetType: 'board_reply', targetId: reply.id as string, targetLabel: 'this reply' }, e.currentTarget)
                                        }
                                      >
                                        <Icon name="flag" size={13} />
                                        Report
                                      </button>
                                      {canBlockAuthor(reply) && (
                                        <button type="button" onClick={() => void handleBlockAuthor('board_reply', reply.id as string)}>
                                          Block author
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                            {post.hasMoreReplies && (
                              <button
                                type="button"
                                onClick={() => void loadThreadReplies(post.id)}
                                disabled={loadingReplies.has(post.id)}
                                className="link-btn mt-1"
                              >
                                {loadingReplies.has(post.id)
                                  ? 'Loading replies…'
                                  : replyPages[post.id] === undefined
                                    ? `Show all ${replyCountOf(post)} replies`
                                    : 'Load more replies'}
                              </button>
                            )}
                            <ReplyInput
                              userId={userId}
                              postId={post.id}
                              threadTitle={post.title}
                              threadBody={post.body || ''}
                              onSubmit={(text) => handleSubmitReply(post.id, text)}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {hasMore && (
              <div className="flex justify-center pt-5">
                <button
                  type="button"
                  onClick={() => void loadMorePosts()}
                  disabled={loadingMore}
                  className="btn btn-secondary"
                >
                  {loadingMore ? 'Loading…' : 'Load more posts'}
                </button>
              </div>
            )}

            {sortedPosts.length === 0 && (
              <div className="empty">
                <span className="ico">
                  <Icon name={normalizedQuery ? 'search' : 'messageCircle'} size={18} />
                </span>
                {normalizedQuery ? (
                  <>
                    <div>
                      <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">No matching threads</p>
                      <p className="mt-1 max-w-[30rem]">
                        Nothing matches &ldquo;{searchQuery.trim()}&rdquo;. Try a different keyword or clear the search.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="btn btn-secondary btn-sm"
                    >
                      <Icon name="close" size={14} />
                      Clear search
                    </button>
                  </>
                ) : (
                  <>
                    <div>
                      <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">No threads yet</p>
                      <p className="mt-1 max-w-[30rem]">
                        Start the conversation - someone else is probably wondering the same thing.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowForm(true)}
                      className="btn btn-secondary btn-sm"
                    >
                      <Icon name="plus" size={15} />
                      Ask a question
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ReplyInput({
  userId,
  postId,
  onSubmit,
  threadTitle = '',
  threadBody = '',
}: {
  userId: string | undefined
  postId: string
  onSubmit: (text: string) => Promise<void> | void
  threadTitle?: string
  threadBody?: string
}) {
  // Kept like the new-post draft, so a reply typed before leaving the board
  // (a link, Back, a session-expiry bounce) is still there on return.
  const [text, setText] = useState(() => loadReplyDraft(userId, postId))
  const [replyError, setReplyError] = useState('')
  const [replyTip, setReplyTip] = useState<string | null>(null)
  const [replyTipLoading, setReplyTipLoading] = useState(false)
  // Set once the student changes the draft in this visit. A restored draft
  // asked for a tip on its own: every drafted thread reopens on load and
  // remounts on each sort change, so each one showed "Thinking" unasked and
  // spent a request from the AI limit the composer's suggestions share.
  const edited = useRef(false)

  useEffect(() => {
    saveReplyDraft(userId, postId, text)
  }, [userId, postId, text])

  useEffect(() => {
    let cancelled = false
    /* eslint-disable react-hooks/set-state-in-effect --
       Intentional synchronous UI sync: clear a stale AI reply tip the moment the
       draft becomes too short, and flag loading before the debounced request.
       These are cleanup resets, not derived state. */
    const d = text.trim()
    if (d.length < 8) {
      setReplyTip(null)
      setReplyTipLoading(false)
      return
    }
    if (!edited.current) return
    const ac = new AbortController()
    setReplyTipLoading(true)
    /* eslint-enable react-hooks/set-state-in-effect */
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/board/ai-suggestions', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: 'reply',
            postTitle: threadTitle,
            postBody: threadBody,
            draft: d,
          }),
          signal: ac.signal,
        })
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setReplyTip(null)
          return
        }
        setReplyTip(data.replyTip?.trim() || null)
      } catch (e) {
        if ((e as { name?: string })?.name !== 'AbortError' && !cancelled) setReplyTip(null)
      } finally {
        if (!cancelled) setReplyTipLoading(false)
      }
    }, 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
      ac.abort()
    }
  }, [text, threadTitle, threadBody])

  const handleSubmit = async () => {
    if (!text.trim()) return
    setReplyError('')
    try {
      await onSubmit(text)
      setText('')
      setReplyTip(null)
    } catch (err) {
      console.error('Reply submit error', err)
      setReplyError(errorText(err, 'Could not post your reply. Try again.'))
    }
  }

  return (
    <div className="mt-2 pt-3 border-t border-[var(--color-border)]">
      <p className="text-[13px] font-semibold text-[var(--color-txt-1)] mb-2">Your reply</p>
      {replyError && (
        <p className="text-[13px] text-[var(--color-error)] mb-2" role="alert">
          {replyError}
        </p>
      )}
      {(replyTipLoading || replyTip) && (
        <div className="r-ai flex items-start gap-2.5 mb-2.5 rounded-[var(--radius-lg)] bg-[var(--color-stat)] px-3 py-2.5">
          <span className="route-badge sm" aria-hidden="true">
            <Icon name="sparkles" size={14} />
          </span>
          <div className="min-w-0">
            <p className="eyebrow bare text-[10.5px] mb-1">
              Suggestion
            </p>
            {replyTipLoading && !replyTip ? (
              <p className="text-[13px] text-[var(--color-txt-3)]">Thinking…</p>
            ) : (
              <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">{replyTip}</p>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={text}
          onChange={(e) => {
            edited.current = true
            setText(e.target.value)
            if (replyError) setReplyError('')
          }}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void handleSubmit()}
          maxLength={MAX_BOARD_REPLY}
          placeholder="Share what you know…"
          className="input flex-1 min-w-0 text-[14px]"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!text.trim()}
          className="btn btn-ink shrink-0"
        >
          <Icon name="send" size={15} />
          Reply
        </button>
      </div>
      <CharCount value={text} max={MAX_BOARD_REPLY} />
    </div>
  )
}

// ── Utilities ──────────────────────────────────────────────────────────────────

// How many replies the thread holds, not how many are on screen: the list route
// previews only the newest few of a long one (issue #200).
function replyCountOf(post: Post) {
  return post.replyCount ?? post.replies.length
}

function dedupeReplies(replies: Reply[]) {
  const seen = new Set<string>()
  return replies.filter((r) => {
    const id = r.id
    if (!id) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function withRelativeTimes(post: Post): Post {
  return {
    ...post,
    isMine: Boolean(post.isMine),
    time: formatRelative(post.time),
    editedTime: post.editedTime ? formatRelative(post.editedTime) : null,
    replies: (post.replies || []).map((r) => ({ ...r, time: formatRelative(r.time) })),
  }
}

// Quiet until the field is nearly full, so a short post carries no chrome.
function CharCount({ value, max }: { value: string; max: number }) {
  if (value.length < max * 0.8) return null
  return (
    <p
      className={`text-[11px] tabular-nums text-right mt-1 ${
        value.length >= max ? 'text-[var(--color-error)]' : 'text-[var(--color-txt-3)]'
      }`}
    >
      {value.length} / {max}
    </p>
  )
}

// Both no-op without a user id (session still loading).
function loadBoardDraft(userId: string | undefined) {
  if (!userId) return { title: '', body: '' }
  try {
    const raw = localStorage.getItem(boardDraftKey(userId))
    if (!raw) return { title: '', body: '' }
    const parsed = JSON.parse(raw)
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      body: typeof parsed.body === 'string' ? parsed.body : '',
    }
  } catch {
    return { title: '', body: '' }
  }
}

function saveBoardDraft(userId: string | undefined, title: string, body: string) {
  if (!userId) return
  try {
    if (!title.trim() && !body.trim()) {
      localStorage.removeItem(boardDraftKey(userId))
    } else {
      localStorage.setItem(boardDraftKey(userId), JSON.stringify({ title, body }))
    }
  } catch {
    /* storage unavailable */
  }
}

function loadReplyDraft(userId: string | undefined, postId: string) {
  if (!userId) return ''
  try {
    return localStorage.getItem(boardReplyDraftKey(userId, postId)) ?? ''
  } catch {
    return ''
  }
}

function saveReplyDraft(userId: string | undefined, postId: string, text: string) {
  if (!userId) return
  try {
    if (!text.trim()) localStorage.removeItem(boardReplyDraftKey(userId, postId))
    else localStorage.setItem(boardReplyDraftKey(userId, postId), text)
  } catch {
    /* storage unavailable */
  }
}

/** Ids of the posts this user has an unsent reply to. */
function postIdsWithReplyDrafts(userId: string | undefined) {
  if (!userId) return []
  const prefix = boardReplyDraftKey(userId, '')
  const ids: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(prefix) && key.length > prefix.length) ids.push(key.slice(prefix.length))
    }
  } catch {
    /* storage unavailable */
  }
  return ids
}

function toggle(set: Set<string>, id: string) {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function formatRelative(isoString: string | null | undefined) {
  if (!isoString) return ''
  const diff = Date.now() - new Date(isoString).getTime()
  const mins  = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (mins < 1)   return 'Just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7)   return `${days}d ago`
  return new Date(isoString).toLocaleDateString()
}
