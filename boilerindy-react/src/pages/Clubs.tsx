import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Icon from '../components/Icons'
import {
  BOILERLINK_URL,
  CLUBS_PAGE_SIZE,
  categoryCount,
  formatFetched,
  initialsFor,
  resultsLabel,
  scopeFromParam,
  type Club,
  type ClubScope,
  type ClubSearchResult,
} from '../lib/clubs'
import { errorMessage, useClubSearch } from '../lib/queries/publicData'

// Student organization directory (issue #16). Data is BoilerLink's public
// organizations API, cached and searched by GET /api/clubs. Indianapolis groups
// come first because that is who this app is for; "All Purdue" is one tap away.
// Events, membership and contacts stay on BoilerLink through the deep links.

const SEARCH_DEBOUNCE_MS = 300
const SCOPES: ClubScope[] = ['indianapolis', 'all']

function ClubLogo({ club }: { club: Club }) {
  const [failed, setFailed] = useState(false)
  if (club.imageUrl && !failed) {
    return (
      <img
        src={club.imageUrl}
        alt=""
        width={56}
        height={56}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="w-14 h-14 rounded-xl object-cover bg-[var(--color-bg-2)] shrink-0"
      />
    )
  }
  return (
    <div
      aria-hidden="true"
      data-club-initials
      className="w-14 h-14 rounded-xl bg-[var(--color-gold)]/15 text-[var(--color-gold)] font-semibold text-[16px] flex items-center justify-center shrink-0"
    >
      {initialsFor(club.name)}
    </div>
  )
}

function ClubCard({ club, scope, onCategory }: { club: Club; scope: ClubScope; onCategory: (name: string) => void }) {
  return (
    <article
      className="card p-4 sm:p-5 flex gap-4 min-w-0"
      data-club-id={club.id}
      data-club-indianapolis={club.indianapolis ? 'true' : 'false'}
    >
      <ClubLogo club={club} />
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-[var(--color-txt-0)] leading-snug m-0 break-words">
            <a href={club.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {club.name}
            </a>
          </h2>
          {club.shortName ? <p className="text-[12px] text-[var(--color-txt-2)] m-0 mt-0.5">{club.shortName}</p> : null}
        </div>
        {club.blurb ? <p className="text-[13px] text-[var(--color-txt-1)] m-0 line-clamp-3 break-words">{club.blurb}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
          {club.indianapolis && scope === 'all' ? (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-gold)]/20 text-[var(--color-gold)]">
              Indianapolis
            </span>
          ) : null}
          {club.categories.slice(0, 3).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onCategory(name)}
              title={`Show ${name} organizations`}
              className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-stat)] text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)] hover:bg-[var(--color-bg-3)] transition-colors"
            >
              {name}
            </button>
          ))}
          <a
            href={club.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-[12px] text-[var(--color-gold)] hover:underline inline-flex items-center gap-1 whitespace-nowrap"
          >
            BoilerLink <Icon name="arrowUpRight" size={12} />
          </a>
        </div>
      </div>
    </article>
  )
}

export default function Clubs() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = (searchParams.get('q') || '').trim()
  const category = (searchParams.get('category') || '').trim()
  const scope = scopeFromParam(searchParams.get('scope'))

  const [input, setInput] = useState(q)
  // The search is one cached entry per set of filters holding every page
  // fetched so far (issue #251): "Show more" appends the next page, a filter
  // the student comes back to answers at once, and while new filters load the
  // previous list stays on screen dimmed, as before.
  const search = useClubSearch({ q, category, scope, pageSize: CLUBS_PAGE_SIZE })
  const pages = useMemo<ClubSearchResult[]>(() => search.data?.pages ?? [], [search.data])
  const result = pages.length > 0 ? pages[pages.length - 1] : null
  const clubs = useMemo<Club[]>(() => pages.flatMap((p) => p.clubs), [pages])
  const loading = search.isPending || search.isPlaceholderData
  const loadingMore = search.isFetchingNextPage
  const requestError = search.isError ? errorMessage(search.error, 'Could not load the club directory.') : null

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(patch)) {
            if (value) next.set(key, value)
            else next.delete(key)
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // The URL is the source of truth for q (back button, category chips, shared
  // links); the box only differs while the user is still typing.
  useEffect(() => {
    setInput((current) => (current.trim() === q ? current : q))
  }, [q])

  useEffect(() => {
    if (input.trim() === q) return
    const timer = setTimeout(() => updateParams({ q: input.trim() || null }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [input, q, updateParams])

  const selectCategory = useCallback((name: string) => updateParams({ category: name || null }), [updateParams])
  const clearFilters = () => {
    setInput('')
    updateParams({ q: null, category: null })
  }

  const total = result?.total ?? 0
  const remaining = Math.max(0, total - clubs.length)
  const canLoadMore = result != null && result.ok && search.hasNextPage
  const categories = (result?.categories ?? []).filter((c) => categoryCount(c, scope) > 0 || c.name === category)
  const categoryKnown = categories.some((c) => c.name === category)
  const fetched = result ? formatFetched(result.fetchedAt) : null

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-txt-3)] mb-1">Purdue Indianapolis</p>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Clubs &amp; Organizations</h1>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">
            Every student organization on BoilerLink, with the Indianapolis groups first.
          </p>
        </div>
        <div
          role="group"
          aria-label="Campus"
          className="inline-flex self-start rounded-xl border border-[var(--color-border)] p-0.5 bg-[var(--color-surface)]"
          data-clubs-scope={scope}
        >
          {SCOPES.map((s) => {
            const count = result ? (s === 'indianapolis' ? result.indianapolisTotal : result.directoryTotal) : null
            return (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s}
                onClick={() => updateParams({ scope: s === 'all' ? 'all' : null })}
                className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                  scope === s
                    ? 'bg-[var(--color-gold)] text-[var(--color-gold-dark)]'
                    : 'text-[var(--color-txt-2)] hover:text-[var(--color-txt-0)]'
                }`}
              >
                {s === 'indianapolis' ? 'Indianapolis' : 'All Purdue'}
                {count != null ? ` (${count.toLocaleString()})` : ''}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Icon name="search" size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-txt-3)] pointer-events-none" />
          <label className="sr-only" htmlFor="clubs-search">
            Search organizations
          </label>
          <input
            id="clubs-search"
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search by name, interest or category"
            autoComplete="off"
            className="input w-full text-[14px] pl-11 pr-10 py-3 rounded-xl border-[var(--color-border-2)] focus:border-[var(--color-accent)]/50"
          />
          {input ? (
            <button
              type="button"
              onClick={() => {
                setInput('')
                updateParams({ q: null })
              }}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-md text-[var(--color-txt-3)] hover:text-[var(--color-txt-0)] hover:bg-[var(--color-bg-2)] transition-colors"
            >
              <Icon name="close" size={14} />
            </button>
          ) : null}
        </div>
        <div className="sm:w-64">
          <label className="sr-only" htmlFor="clubs-category">
            Category
          </label>
          <select
            id="clubs-category"
            value={category}
            onChange={(e) => selectCategory(e.target.value)}
            className="input w-full text-[13px] px-3 py-3 rounded-xl border-[var(--color-border-2)]"
          >
            <option value="">All categories</option>
            {!categoryKnown && category ? <option value={category}>{category}</option> : null}
            {categories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({categoryCount(c, scope).toLocaleString()})
              </option>
            ))}
          </select>
        </div>
      </div>

      {requestError ? (
        <div className="card p-4 mb-6 text-[13px] text-[var(--color-error)] border-[var(--color-error)]/30">{requestError}</div>
      ) : null}

      {result && !result.ok ? (
        <div className="card p-4 mb-6 text-[13px] text-[var(--color-txt-1)] flex items-start gap-3" data-clubs-degraded>
          <Icon name="info" size={16} className="shrink-0 mt-0.5 text-[var(--color-txt-2)]" />
          <p className="m-0">
            BoilerLink is not answering right now, so the directory is empty. It usually comes back within a few minutes. You can
            still{' '}
            <a href={BOILERLINK_URL} target="_blank" rel="noopener noreferrer" className="text-[var(--color-gold)] hover:underline">
              open BoilerLink directly
            </a>
            .
          </p>
        </div>
      ) : null}

      <p className="text-[12px] text-[var(--color-txt-2)] mb-3 min-h-[1rem]" aria-live="polite" data-clubs-results>
        {result && result.ok ? resultsLabel({ total, q, category, scope }) : ''}
      </p>

      {!result && loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="card p-5 flex gap-4">
              <div className="w-14 h-14 rounded-xl bg-[var(--color-stat)] shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-3/4 rounded bg-[var(--color-stat)]" />
                <div className="h-3 w-full rounded bg-[var(--color-stat)]" />
                <div className="h-3 w-5/6 rounded bg-[var(--color-stat)]" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={`grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
          {clubs.map((club) => (
            <ClubCard key={club.id} club={club} scope={scope} onCategory={selectCategory} />
          ))}
        </div>
      )}

      {result && result.ok && !loading && clubs.length === 0 ? (
        <div className="card p-6 mb-6 text-center" data-clubs-empty>
          <p className="text-[14px] text-[var(--color-txt-1)] m-0">
            No organizations match{q ? ` "${q}"` : ''}
            {category ? ` in ${category}` : ''}
            {scope === 'indianapolis' ? ' in Indianapolis' : ''}.
          </p>
          <div className="flex flex-wrap justify-center gap-2 mt-4">
            {scope === 'indianapolis' ? (
              <button type="button" onClick={() => updateParams({ scope: 'all' })} className="btn btn-primary text-[12px] px-4 py-2">
                Search all of Purdue
              </button>
            ) : null}
            {q || category ? (
              <button type="button" onClick={clearFilters} className="btn btn-secondary text-[12px] px-4 py-2">
                Clear filters
              </button>
            ) : null}
            <a href={BOILERLINK_URL} target="_blank" rel="noopener noreferrer" className="btn btn-secondary text-[12px] px-4 py-2 no-underline">
              Open BoilerLink <Icon name="arrowUpRight" size={12} />
            </a>
          </div>
        </div>
      ) : null}

      {canLoadMore ? (
        <div className="flex justify-center mb-8">
          <button
            type="button"
            onClick={() => void search.fetchNextPage()}
            disabled={loadingMore}
            className="btn btn-secondary text-[13px] px-5 py-2.5"
          >
            {loadingMore ? 'Loading' : `Show more (${remaining.toLocaleString()} left)`}
          </button>
        </div>
      ) : null}

      {result ? (
        <p className="text-[11px] text-[var(--color-txt-3)]">
          Directory from{' '}
          <a href={BOILERLINK_URL} target="_blank" rel="noopener noreferrer" className="underline">
            BoilerLink
          </a>
          , Purdue&apos;s student organization hub, refreshed a few times a day{fetched ? ` (last ${fetched})` : ''}. Membership, events
          and contacts live on each organization&apos;s BoilerLink page. Indianapolis groups are the ones that say so in their name or
          description; a Purdue-wide organization may still welcome Indianapolis members.
        </p>
      ) : null}
    </div>
  )
}
