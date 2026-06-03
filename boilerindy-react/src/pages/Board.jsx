import { useState, useEffect, useCallback, useMemo } from 'react'
import { authRequest } from '../lib/authApi'
import Icon from '../components/Icons'

export default function Board() {
  const [posts, setPosts] = useState([])
  const [sort, setSort] = useState('recent')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(new Set())
  const [repliesOpen, setRepliesOpen] = useState(new Set())
  const [showForm, setShowForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newBody, setNewBody] = useState('')
  const [isAnon, setIsAnon] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [improving, setImproving] = useState(false)
  const [postError, setPostError] = useState('')
  const [filterTag, setFilterTag] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [liveCompose, setLiveCompose] = useState(null)
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
      const data = await res.json()
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
  const fetchPosts = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true)
      const data = await authRequest(`/api/board/posts?sort=${sort}`)
      setPosts((data.posts || []).map((p) => ({
        ...p,
        isMine: Boolean(p.isMine),
        time: formatRelative(p.time),
        replies: (p.replies || []).map((r) => ({ ...r, time: formatRelative(r.time) })),
      })))
    } catch (err) {
      console.error('Board fetch error', err)
      if (!silent) setPosts([])
    } finally {
      if (!silent) setLoading(false)
    }
  }, [sort])

  useEffect(() => { fetchPosts() }, [fetchPosts])

  // ── Live AI suggestions (debounced) while composing ─────────────────────
  useEffect(() => {
    let cancelled = false
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
        setLiveCompose(has ? data : null)
      } catch (e) {
        if (e?.name !== 'AbortError' && !cancelled) setLiveCompose(null)
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
  const handleUpvote = async (id) => {
    // Optimistic update
    setPosts(prev => prev.map(p =>
      p.id === id
        ? { ...p, upvotes: p.upvotedByMe ? p.upvotes - 1 : p.upvotes + 1, upvotedByMe: !p.upvotedByMe }
        : p
    ))
    try {
      const data = await authRequest(`/api/board/posts/${id}/upvote`, { method: 'POST' })
      setPosts(prev => prev.map(p =>
        p.id === id ? { ...p, upvotes: data.upvotes, upvotedByMe: data.upvotedByMe } : p
      ))
    } catch {
      // Revert
      setPosts(prev => prev.map(p =>
        p.id === id
          ? { ...p, upvotes: p.upvotedByMe ? p.upvotes - 1 : p.upvotes + 1, upvotedByMe: !p.upvotedByMe }
          : p
      ))
    }
  }

  const toggleExpand  = (id) => setExpanded(prev => toggle(prev, id))
  const toggleReplies = (id) => setRepliesOpen(prev => toggle(prev, id))

  const handleDeletePost = async (id) => {
    if (
      !window.confirm(
        'Delete this post and all of its replies? This cannot be undone.',
      )
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
      window.alert(err?.message || 'Could not delete this post.')
    } finally {
      setDeletingId(null)
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
      setNewTitle('')
      setNewBody('')
      setLiveCompose(null)
      setShowForm(false)
      setFilterTag(null)
      await fetchPosts({ silent: true })
    } catch (err) {
      console.error('Post submit error', err)
      setPostError(err?.message || 'Could not publish your post. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Submit reply ───────────────────────────────────────────────────────────
  const handleSubmitReply = async (postId, text) => {
    if (!text.trim()) return
    const data = await authRequest(`/api/board/posts/${postId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body: text, anon: false }),
    })
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? { ...p, replies: [...p.replies, { ...data.reply, time: 'Just now' }] }
          : p,
      ),
    )
  }

  const [threadSummaries, setThreadSummaries] = useState({})
  const [summarizing, setSummarizing] = useState(new Set())

  const summarizeThread = async (post) => {
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
            content: `Summarize this campus board discussion in 2-3 concise bullet points. What is the main question and what are the key answers or opinions? No markdown headers.\n\n${threadText}`,
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
    const counts = {}
    for (const p of posts) {
      for (const t of p.tags || []) {
        counts[t] = (counts[t] || 0) + 1
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }))
  }, [posts])

  const sortedPosts = [...posts]
    .filter((p) => !filterTag || (p.tags || []).includes(filterTag))
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return sort === 'popular' ? b.upvotes - a.upvotes : 0
    })

  return (
    <div className="max-w-[42rem] mx-auto px-4 sm:px-6 py-8 pb-28">
      {/* Hero */}
      <header className="relative overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)] mb-8">
        <div className="absolute inset-0 bg-gradient-to-br from-[var(--color-accent-bg)]/90 via-[var(--color-gold)]/6 to-transparent pointer-events-none" />
        <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-[var(--color-accent)]/5 blur-3xl -translate-y-1/2 translate-x-1/4 pointer-events-none" />
        <div className="relative px-5 sm:px-7 py-6 sm:py-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5">
          <div className="flex gap-4 min-w-0">
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-sm)] flex items-center justify-center shrink-0">
              <Icon name="messageCircle" size={26} className="text-[var(--color-accent)]" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-semibold text-[var(--color-txt-0)] tracking-tight">
                Campus Board
              </h1>
              <p className="text-[13px] sm:text-[14px] text-[var(--color-txt-2)] mt-1.5 leading-relaxed max-w-md">
                Ask questions, share tips, and help each other navigate Purdue Indianapolis.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
            setShowForm(!showForm)
            if (showForm) setPostError('')
          }}
            className={`shrink-0 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[13px] font-semibold transition-all shadow-[var(--shadow-sm)] ${
              showForm
                ? 'bg-[var(--color-stat)] text-[var(--color-txt-1)] border border-[var(--color-border)] hover:bg-[var(--color-bg-3)]'
                : 'bg-[var(--color-accent)] text-white hover:brightness-110 border border-transparent'
            }`}
          >
            <Icon name={showForm ? 'close' : 'plus'} size={17} />
            {showForm ? 'Close' : 'New question'}
          </button>
        </div>
      </header>

      {/* Compose — scrollable so Post is never clipped on small viewports */}
      <div
        className={`transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          showForm ? 'max-h-[min(85vh,720px)] opacity-100 mb-8 overflow-y-auto overscroll-contain' : 'max-h-0 opacity-0 mb-0 overflow-hidden pointer-events-none'
        }`}
      >
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-md)] p-5 sm:p-6">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-accent)]">Compose</span>
            <div className="h-px flex-1 bg-gradient-to-r from-[var(--color-accent)]/25 to-transparent" />
          </div>
          {postError && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-[var(--color-error)]/35 bg-[var(--color-error)]/8 px-4 py-3 text-[13px] text-[var(--color-error)]"
            >
              {postError}
            </div>
          )}
          <label className="sr-only" htmlFor="board-new-title">
            Question title
          </label>
          <input
            id="board-new-title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="What do you want to ask campus?"
            className="input w-full text-[15px] font-medium px-4 py-3.5 mb-3 rounded-xl border-[var(--color-border-2)] focus:border-[var(--color-accent)]/50"
          />
          <label className="sr-only" htmlFor="board-new-body">
            Optional details
          </label>
          <textarea
            id="board-new-body"
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder="Optional context — course, building, deadline…"
            className="input w-full text-[14px] px-4 py-3.5 resize-y min-h-[108px] mb-4 rounded-xl border-[var(--color-border-2)] focus:border-[var(--color-accent)]/50"
          />

          {(liveComposeLoading || liveCompose) && (
            <div className="mb-5 rounded-xl border border-[var(--color-accent)]/20 bg-[var(--color-accent-bg)]/40 px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Icon name="sparkles" size={14} className="text-[var(--color-accent)] shrink-0" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-accent)]">
                  Live suggestions
                </span>
                {liveComposeLoading && (
                  <span className="text-[11px] text-[var(--color-txt-3)] ml-auto">Updating…</span>
                )}
              </div>
              {liveComposeLoading && !liveCompose && (
                <p className="text-[12px] text-[var(--color-txt-2)]">Checking title, details, and tags…</p>
              )}
              {liveCompose?.betterTitle && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border)]/60">
                  <p className="text-[10px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wide mb-1">
                    Clearer title
                  </p>
                  <p className="text-[13px] text-[var(--color-txt-1)] leading-snug mb-2">{liveCompose.betterTitle}</p>
                  <button
                    type="button"
                    onClick={() => setNewTitle(liveCompose.betterTitle)}
                    className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    Use this title
                  </button>
                </div>
              )}
              {liveCompose?.bodyAddOn && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border)]/60">
                  <p className="text-[10px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wide mb-1">
                    Add context
                  </p>
                  <p className="text-[13px] text-[var(--color-txt-1)] leading-snug mb-2">{liveCompose.bodyAddOn}</p>
                  <button
                    type="button"
                    onClick={() =>
                      setNewBody((prev) => {
                        const add = liveCompose.bodyAddOn.trim()
                        if (!prev.trim()) return add
                        return `${prev.trim()}\n\n${add}`
                      })
                    }
                    className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
                  >
                    Append to details
                  </button>
                </div>
              )}
              {liveCompose?.tags?.length > 0 && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border)]/60">
                  <p className="text-[10px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wide mb-1.5">
                    Likely tags after you post
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {liveCompose.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-txt-2)]"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <label className="flex items-center gap-3 text-[13px] text-[var(--color-txt-1)] cursor-pointer select-none group">
              <div
                role="checkbox"
                aria-checked={isAnon}
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setIsAnon((v) => !v)}
                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all shrink-0 ${
                  isAnon
                    ? 'bg-[var(--color-gold)] border-[var(--color-gold)] shadow-sm'
                    : 'border-[var(--color-border-2)] bg-[var(--color-surface)] group-hover:border-[var(--color-txt-3)]'
                }`}
                onClick={() => setIsAnon((v) => !v)}
              >
                {isAnon && <Icon name="check" size={12} className="text-[var(--color-gold-dark)]" strokeWidth={3} />}
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
                className="btn btn-secondary text-[13px] px-4 py-2.5 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                title="Let AI rewrite your post to be clearer"
              >
                <Icon name="sparkles" size={14} />
                {improving ? 'Improving…' : 'Polish with AI'}
              </button>
              <button
                type="button"
                onClick={handleSubmitPost}
                disabled={!newTitle.trim() || submitting}
                className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold bg-[var(--color-accent)] text-white disabled:opacity-45 disabled:cursor-not-allowed hover:brightness-110 transition-all"
              >
                {submitting ? 'Posting…' : 'Post'}
                <Icon name="send" size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="inline-flex p-1 rounded-xl bg-[var(--color-stat)] border border-[var(--color-border)] w-fit">
          {['recent', 'popular'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={`px-4 py-2 rounded-lg text-[12px] font-semibold capitalize transition-all ${
                sort === s
                  ? 'bg-[var(--color-surface)] text-[var(--color-txt-0)] shadow-[var(--shadow-sm)]'
                  : 'text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="text-[12px] font-medium text-[var(--color-txt-3)] tabular-nums">
          {sortedPosts.length} {sortedPosts.length === 1 ? 'thread' : 'threads'}
        </span>
      </div>

      {allTags.length > 0 && (
        <div className="flex gap-2 mb-6 overflow-x-auto pb-1 scrollbar-thin -mx-1 px-1 [scrollbar-width:thin]">
          <button
            type="button"
            onClick={() => setFilterTag(null)}
            className={`shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-lg border transition-all ${
              !filterTag
                ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)] shadow-sm'
                : 'bg-[var(--color-surface)] text-[var(--color-txt-2)] border-[var(--color-border)] hover:border-[var(--color-accent)]/30'
            }`}
          >
            All topics
          </button>
          {allTags.map(({ tag, count }) => (
            <button
              key={tag}
              type="button"
              onClick={() => setFilterTag(filterTag === tag ? null : tag)}
              className={`shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-lg border transition-all ${
                filterTag === tag
                  ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)] shadow-sm'
                  : 'bg-[var(--color-surface)] text-[var(--color-txt-2)] border-[var(--color-border)] hover:border-[var(--color-accent)]/30'
              }`}
            >
              #{tag}
              <span className="opacity-70 font-normal ml-1">{count}</span>
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)] py-16 px-6 text-center">
          <div className="w-10 h-10 border-2 border-[var(--color-accent)]/30 border-t-[var(--color-accent)] rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[14px] font-medium text-[var(--color-txt-1)]">Loading threads…</p>
          <p className="text-[12px] text-[var(--color-txt-3)] mt-1">Hang tight</p>
        </div>
      )}

      {!loading && (
        <div className="space-y-4">
          {sortedPosts.map((post, idx) => (
            <article
              key={post.id}
              className={`group rounded-2xl border bg-[var(--color-surface)] shadow-[var(--shadow-sm)] overflow-hidden transition-all duration-300 hover:shadow-[var(--shadow-md)] animate-fade-in-up ${
                post.pinned
                  ? 'border-[var(--color-gold-muted)]/50 ring-1 ring-[var(--color-gold)]/20'
                  : 'border-[var(--color-border)]'
              }`}
              style={{ animationDelay: `${idx * 0.04}s` }}
            >
              <div className="flex min-w-0">
                <button
                  type="button"
                  onClick={() => handleUpvote(post.id)}
                  aria-pressed={post.upvotedByMe}
                  className={`flex flex-col items-center justify-center gap-0.5 w-[52px] sm:w-[58px] shrink-0 border-r border-[var(--color-border)] transition-colors ${
                    post.upvotedByMe
                      ? 'bg-gradient-to-b from-[var(--color-gold)]/15 to-[var(--color-gold)]/5 text-[var(--color-gold-muted)]'
                      : 'bg-[var(--color-stat)]/80 text-[var(--color-txt-2)] hover:bg-[var(--color-stat)]'
                  }`}
                >
                  <Icon name="chevronUp" size={18} strokeWidth={2.5} className={post.upvotedByMe ? 'text-[var(--color-gold-muted)]' : ''} />
                  <span className="text-[13px] font-bold tabular-nums">{post.upvotes}</span>
                </button>

                <div className="flex-1 min-w-0 p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {post.pinned && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md bg-[var(--color-gold)]/20 text-[var(--color-gold-muted)] border border-[var(--color-gold)]/25">
                        <Icon name="pin" size={9} />
                        Pinned
                      </span>
                    )}
                    {post.hot && !post.pinned && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md bg-[var(--color-events-bg)] text-[var(--color-events-color)]">
                        Trending
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => toggleExpand(post.id)}
                    className="w-full text-left text-[15px] sm:text-[16px] font-semibold text-[var(--color-txt-0)] leading-snug hover:text-[var(--color-accent)] transition-colors"
                  >
                    {post.title}
                    {post.body ? (
                      <span className="block text-[11px] font-normal text-[var(--color-txt-3)] mt-1">
                        {expanded.has(post.id) ? 'Tap to collapse' : 'Tap to read more'}
                      </span>
                    ) : null}
                  </button>

                  {post.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {post.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-[var(--color-accent-bg)] text-[var(--color-accent)] border border-[var(--color-accent)]/15"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div
                    className={`grid transition-all duration-300 ease-out ${
                      expanded.has(post.id) && post.body ? 'grid-rows-[1fr] mt-3' : 'grid-rows-[0fr]'
                    }`}
                  >
                    <div className="overflow-hidden min-h-0">
                      <p className="text-[14px] text-[var(--color-txt-1)] leading-relaxed pr-1">{post.body}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mt-4 pt-3 border-t border-[var(--color-border)] text-[12px] text-[var(--color-txt-3)]">
                    <span className="inline-flex items-center gap-2 text-[var(--color-txt-2)]">
                      <span className="w-7 h-7 rounded-full bg-[var(--color-accent-bg)] text-[var(--color-accent)] text-[11px] font-bold flex items-center justify-center">
                        {post.user.charAt(0).toUpperCase()}
                      </span>
                      <span className="font-medium">{post.user}</span>
                    </span>
                    <span className="text-[var(--color-txt-3)]">·</span>
                    <span>{post.time}</span>
                    {post.isMine && (
                      <button
                        type="button"
                        onClick={() => handleDeletePost(post.id)}
                        disabled={deletingId === post.id}
                        className="inline-flex items-center gap-1 text-[12px] font-semibold text-red-600/90 dark:text-red-400/90 hover:underline disabled:opacity-50"
                      >
                        <Icon name="trash" size={13} />
                        {deletingId === post.id ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleReplies(post.id)}
                      className="inline-flex items-center gap-1.5 ml-auto sm:ml-0 text-[var(--color-accent)] font-semibold hover:underline"
                    >
                      <Icon name="message" size={13} />
                      {post.replies.length} {post.replies.length === 1 ? 'reply' : 'replies'}
                    </button>
                  </div>

                  <div
                    className={`grid transition-all duration-300 ease-out ${
                      repliesOpen.has(post.id) ? 'grid-rows-[1fr] mt-4' : 'grid-rows-[0fr]'
                    }`}
                  >
                    <div className="overflow-hidden min-h-0">
                      <div className="rounded-xl bg-[var(--color-stat)]/60 border border-[var(--color-border)] p-4 sm:p-5">
                        {post.replies.length >= 5 && (
                          <div className="mb-4">
                            {threadSummaries[post.id] ? (
                              <div className="rounded-xl p-4 bg-[var(--color-surface)] border border-[var(--color-gold)]/25 shadow-[var(--shadow-sm)]">
                                <div className="flex items-center gap-2 mb-2">
                                  <Icon name="sparkles" size={14} className="text-[var(--color-gold-muted)]" />
                                  <span className="text-[10px] font-bold text-[var(--color-gold-muted)] uppercase tracking-wider">
                                    Thread summary
                                  </span>
                                </div>
                                <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed whitespace-pre-line">
                                  {threadSummaries[post.id]}
                                </p>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => summarizeThread(post)}
                                disabled={summarizing.has(post.id)}
                                className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-gold-muted)] hover:text-[var(--color-gold)] transition-colors disabled:opacity-40"
                              >
                                <Icon name="sparkles" size={14} />
                                {summarizing.has(post.id) ? 'Summarizing…' : 'Summarize long thread'}
                              </button>
                            )}
                          </div>
                        )}
                        <ul className="space-y-0">
                          {post.replies.map((reply, i) => (
                            <li
                              key={reply.id ?? i}
                              className="relative pl-4 py-3 border-b border-[var(--color-border)] last:border-0 last:pb-0"
                            >
                              <div className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-[var(--color-accent)]/25" />
                              <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">{reply.body}</p>
                              <div className="flex items-center gap-2 mt-2 text-[11px] text-[var(--color-txt-3)]">
                                <span className="w-5 h-5 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center text-[8px] font-bold text-[var(--color-txt-2)]">
                                  {reply.user.charAt(0).toUpperCase()}
                                </span>
                                <span className="font-medium text-[var(--color-txt-2)]">{reply.user}</span>
                                <span>·</span>
                                <span>{reply.time}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                        <ReplyInput
                          threadTitle={post.title}
                          threadBody={post.body || ''}
                          onSubmit={(text) => handleSubmitReply(post.id, text)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          ))}

          {sortedPosts.length === 0 && (
            <div className="rounded-2xl border-2 border-dashed border-[var(--color-border-2)] bg-[var(--color-stat)]/40 py-16 px-8 text-center">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-sm)] flex items-center justify-center mb-4">
                <Icon name="messageCircle" size={30} className="text-[var(--color-txt-3)]" />
              </div>
              <p className="text-[16px] font-semibold text-[var(--color-txt-0)]">No threads yet</p>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-2 max-w-xs mx-auto leading-relaxed">
                Start the conversation — someone else is probably wondering the same thing.
              </p>
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="mt-6 inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold bg-[var(--color-accent)] text-white hover:brightness-110 transition-all shadow-[var(--shadow-sm)]"
              >
                <Icon name="plus" size={16} />
                Ask a question
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ReplyInput({ onSubmit, threadTitle = '', threadBody = '' }) {
  const [text, setText] = useState('')
  const [replyError, setReplyError] = useState('')
  const [replyTip, setReplyTip] = useState(null)
  const [replyTipLoading, setReplyTipLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const d = text.trim()
    if (d.length < 8) {
      setReplyTip(null)
      setReplyTipLoading(false)
      return
    }
    const ac = new AbortController()
    setReplyTipLoading(true)
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
        if (e?.name !== 'AbortError' && !cancelled) setReplyTip(null)
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
      setReplyError(err?.message || 'Could not post your reply. Try again.')
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-[var(--color-border)]">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-txt-3)] mb-2">Your reply</p>
      {replyError && (
        <p className="text-[12px] text-red-600 dark:text-red-400 mb-2" role="alert">
          {replyError}
        </p>
      )}
      {(replyTipLoading || replyTip) && (
        <div className="flex items-start gap-2 mb-2 rounded-lg border border-[var(--color-accent)]/15 bg-[var(--color-accent-bg)]/30 px-3 py-2">
          <Icon name="sparkles" size={12} className="text-[var(--color-accent)] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-accent)] mb-0.5">
              Suggestion
            </p>
            {replyTipLoading && !replyTip ? (
              <p className="text-[11px] text-[var(--color-txt-3)]">Thinking…</p>
            ) : (
              <p className="text-[11px] text-[var(--color-txt-2)] leading-relaxed">{replyTip}</p>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (replyError) setReplyError('')
          }}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void handleSubmit()}
          placeholder="Share what you know…"
          className="input flex-1 text-[13px] px-4 py-3 rounded-xl border-[var(--color-border-2)] bg-[var(--color-surface)] min-w-0"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!text.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[13px] font-semibold bg-[var(--color-accent)] text-white disabled:opacity-45 shrink-0 hover:brightness-110 transition-all"
        >
          <Icon name="send" size={15} />
          Reply
        </button>
      </div>
    </div>
  )
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function toggle(set, id) {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function formatRelative(isoString) {
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
