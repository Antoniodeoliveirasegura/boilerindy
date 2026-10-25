import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Icon from '../components/Icons'
import { useAuth } from '../context/AuthContext'
import type { ApiRequestError } from '../lib/authApi'
import {
  BOILERLINK_URL,
  CLUBS_PAGE_SIZE,
  categoryCount,
  filterFollowedClubs,
  followedCategories,
  followingFromParam,
  followingLabel,
  formatFetched,
  initialsFor,
  organizationKeyOf,
  resultsLabel,
  scopeFromParam,
  type Club,
  type ClubScope,
  type ClubSearchResult,
} from '../lib/clubs'
import { errorMessage, useCampusNews, useClubSearch } from '../lib/queries/publicData'
import { useMyClubFollows, useToggleClubFollow, useUserId } from '../lib/queries/userData'
import { writeFailureMessage } from '../lib/writeFailure'
import PageTitle from '../components/PageTitle'

// Student organization directory (issue #16). Data is BoilerLink's public
// organizations API, cached and searched by GET /api/clubs. Indianapolis groups
// come first because that is who this app is for; "All Purdue" is one tap away.
// Events, membership and contacts stay on BoilerLink through the deep links.
//
// A signed-in student can follow clubs (GET, PUT and DELETE
// /api/me/club-follows, docs/clubs.md#following-a-club): a Follow toggle on
// every card, and a Following view (?following=1) of the clubs they follow.
// Their events then have a "Clubs I follow" pill on Events and Free Food. No
// follow UI shows without an account, or before the server has the follows
// table (README step 48), which answers club_follows_schema_missing.

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
        className="w-14 h-14 rounded-[var(--radius-md)] object-cover bg-[var(--color-stat)] outline -outline-offset-1 outline-[color:var(--color-border-2)] shrink-0"
      />
    )
  }
  return (
    <div
      aria-hidden="true"
      data-club-initials
      className="w-14 h-14 rounded-[var(--radius-md)] bg-[var(--route-tint)] text-[var(--route-text)] font-display font-extrabold text-[17px] tracking-[0.02em] flex items-center justify-center shrink-0"
    >
      {initialsFor(club.name)}
    </div>
  )
}

/** A card's Follow toggle: whether the student follows the club, and whether a change is on its way. */
type FollowControl = { following: boolean; busy: boolean; onToggle: () => void }

function ClubCard({
  club,
  scope,
  onCategory,
  follow,
}: {
  club: Club
  scope: ClubScope
  onCategory: (name: string) => void
  follow: FollowControl | null
}) {
  return (
    <article
      className="card card-pad r-evt flex gap-4 min-w-0"
      data-club-id={club.id}
      data-club-indianapolis={club.indianapolis ? 'true' : 'false'}
    >
      <ClubLogo club={club} />
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        <div className="min-w-0">
          <h2 className="text-[16px] leading-snug text-[var(--color-txt-0)] m-0 break-words">
            <a href={club.url} target="_blank" rel="noopener noreferrer" className="hover:underline underline-offset-[3px]">
              {club.name}
            </a>
          </h2>
          {club.shortName ? <p className="text-[12.5px] text-[var(--color-txt-2)] m-0 mt-0.5">{club.shortName}</p> : null}
        </div>
        {club.blurb ? <p className="text-[14px] leading-[1.45] text-[var(--color-txt-1)] m-0 line-clamp-3 break-words">{club.blurb}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
          {club.indianapolis && scope === 'all' ? (
            <span className="badge badge-route">
              Indianapolis
            </span>
          ) : null}
          {club.categories.slice(0, 3).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onCategory(name)}
              title={`Show ${name} organizations`}
              className="chip text-left whitespace-normal hover:bg-[var(--color-bg-3)] hover:text-[var(--color-txt-0)] transition-colors"
            >
              {name}
            </button>
          ))}
          <span className="ml-auto inline-flex items-center gap-3">
            {follow ? (
              <button
                type="button"
                onClick={follow.onToggle}
                disabled={follow.busy}
                aria-pressed={follow.following}
                data-club-follow={follow.following ? 'following' : 'not-following'}
                className={`pill whitespace-nowrap ${follow.following ? 'pill-active' : ''}`}
              >
                {follow.following ? (
                  <span aria-hidden="true" className="flex">
                    <Icon name="check" size={13} />
                  </span>
                ) : null}
                {follow.following ? 'Following' : 'Follow'}{' '}
                <span className="sr-only">{club.name}</span>
              </button>
            ) : null}
            <a
              href={club.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 min-h-[32px] font-display font-bold text-[13px] text-[var(--color-accent)] hover:underline underline-offset-[3px] whitespace-nowrap"
            >
              BoilerLink <Icon name="arrowUpRight" size={12} />
            </a>
          </span>
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
  // The newest student-orgs story from The Circuit (issue #470), today its
  // club guide: a link out, nothing of the article.
  const news = useCampusNews()
  const orgsStory = news.data?.posts?.find((post) => post.tag === 'Student Orgs')
  const pages = useMemo<ClubSearchResult[]>(() => search.data?.pages ?? [], [search.data])
  const result = pages.length > 0 ? pages[pages.length - 1] : null
  const clubs = useMemo<Club[]>(() => pages.flatMap((p) => p.clubs), [pages])
  const loading = search.isPending || search.isPlaceholderData
  const loadingMore = search.isFetchingNextPage
  const requestError = search.isError ? errorMessage(search.error, 'Could not load the club directory.') : null

  // Following (issue #16): signed in only. Until the follows have loaded the
  // cards show no toggle, since one that read "Follow" for a club already
  // followed would undo it.
  const { user } = useAuth()
  const userId = useUserId()
  const follows = useMyClubFollows()
  // Following is not there yet, rather than broken: the follows table is
  // missing (README step 48), or a server older than this page has no such
  // route (a 404 while a release deploys the website ahead of the API).
  const followsError = follows.error as ApiRequestError | null
  const followsUnavailable = followsError?.code === 'club_follows_schema_missing' || followsError?.status === 404
  const followsData = user ? follows.data : undefined
  const followedKeys = useMemo(() => new Set(followsData?.follows ?? []), [followsData])
  // The Following view (?following=1) waits for the follows, and gives way to
  // the directory when they cannot be read.
  const following = Boolean(user) && !follows.isError && followingFromParam(searchParams.get('following'))
  const followingLoading = following && !followsData
  const toggleFollow = useToggleClubFollow(userId)
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [followError, setFollowError] = useState<string | null>(null)

  const followControl = (club: Club): FollowControl | null => {
    if (!followsData) return null
    const key = organizationKeyOf(club)
    const isFollowing = followedKeys.has(key)
    return {
      following: isFollowing,
      busy: busyKeys.has(key),
      onToggle: () => {
        setFollowError(null)
        setBusyKeys((current) => new Set(current).add(key))
        toggleFollow
          .mutateAsync({ club, following: !isFollowing })
          .catch((error: unknown) => {
            // The follow routes' 503s say what is wrong in words a student
            // can read (docs/api-error-codes.md); other 5xx messages may not.
            const known = (error as ApiRequestError | null)?.code?.startsWith('club_follows_')
            const what = `Could not ${isFollowing ? 'unfollow' : 'follow'} ${club.name}.`
            setFollowError(known && error instanceof Error ? `${what} ${error.message}` : `${what} ${writeFailureMessage(error, 'Please try again.')}`)
          })
          .finally(() =>
            setBusyKeys((current) => {
              const next = new Set(current)
              next.delete(key)
              return next
            }),
          )
      },
    }
  }

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

  // The Following view lists the followed clubs the directory has, filtered
  // here by the same search box and category menu (at most 100 clubs).
  const followedClubs = followsData?.clubs ?? []
  const followingClubs = filterFollowedClubs(followedClubs, { q, category })
  const shownClubs = following ? followingClubs : clubs

  const total = result?.total ?? 0
  const remaining = Math.max(0, total - clubs.length)
  const canLoadMore = !following && result != null && result.ok && search.hasNextPage
  // The category menu counts what the view lists: the scope's clubs, or the followed ones.
  const categories: { name: string; count: number }[] = following
    ? followedCategories(followedClubs)
    : (result?.categories ?? [])
        .filter((c) => categoryCount(c, scope) > 0 || c.name === category)
        .map((c) => ({ name: c.name, count: categoryCount(c, scope) }))
  const categoryKnown = categories.some((c) => c.name === category)
  const fetched = result ? formatFetched(result.fetchedAt) : null
  const showSkeleton = following ? followingLoading : !result && loading

  return (
    <div className="page">
      <PageTitle>Clubs & Organizations</PageTitle>
      <header className="page-head">
        <div>
          <p className="eyebrow">Purdue Indianapolis</p>
          <h1 className="page-title">Clubs &amp; Organizations</h1>
          <p className="page-sub">
            Every student organization on BoilerLink, with the Indianapolis groups first.
          </p>
          {orgsStory && (
            <p className="mt-2 text-[13px] text-[var(--color-txt-2)]" data-clubs-circuit>
              From The Circuit, Purdue Indy&apos;s student newspaper:{' '}
              <a href={orgsStory.url} target="_blank" rel="noopener noreferrer" className="prose-link">
                {orgsStory.title}
              </a>
            </p>
          )}
        </div>
        <div
          role="group"
          aria-label="Campus"
          className="flex flex-wrap gap-2"
          data-clubs-scope={following ? 'following' : scope}
        >
          {SCOPES.map((s) => {
            const count = result ? (s === 'indianapolis' ? result.indianapolisTotal : result.directoryTotal) : null
            return (
              <button
                key={s}
                type="button"
                aria-pressed={!following && scope === s}
                onClick={() => updateParams({ scope: s === 'all' ? 'all' : null, following: null })}
                className={`pill tnum ${!following && scope === s ? 'pill-active' : ''}`}
              >
                {s === 'indianapolis' ? 'Indianapolis' : 'All Purdue'}
                {count != null ? ` (${count.toLocaleString()})` : ''}
              </button>
            )
          })}
          {followsData || following ? (
            <button
              type="button"
              aria-pressed={following}
              onClick={() => updateParams({ following: '1' })}
              className={`pill tnum ${following ? 'pill-active' : ''}`}
            >
              Following{followsData ? ` (${followsData.follows.length.toLocaleString()})` : ''}
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Icon name="search" size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-txt-3)] pointer-events-none" />
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
            className={`input pl-10 ${input ? 'pr-11' : ''}`}
          />
          {input ? (
            <button
              type="button"
              onClick={() => {
                setInput('')
                updateParams({ q: null })
              }}
              aria-label="Clear search"
              className="icon-btn absolute right-0.5 top-1/2 -translate-y-1/2 w-10 h-10 text-[var(--color-txt-3)]"
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
            className="input"
          >
            <option value="">All categories</option>
            {!categoryKnown && category ? <option value={category}>{category}</option> : null}
            {categories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.count.toLocaleString()})
              </option>
            ))}
          </select>
        </div>
      </div>

      {requestError ? (
        <div className="card p-4 mb-6 text-[13px] text-[var(--color-error)] border-[var(--color-error)]/30">{requestError}</div>
      ) : null}

      {user && follows.isError && !followsUnavailable ? (
        <div className="card p-4 mb-6 text-[13px] text-[var(--color-txt-1)] flex flex-wrap items-center gap-3" data-clubs-follows-failed>
          <span>Could not load the clubs you follow, so the Follow buttons are hidden.</span>
          <button type="button" onClick={() => void follows.refetch()} disabled={follows.isFetching} className="btn btn-secondary btn-sm">
            {follows.isFetching ? 'Trying again…' : 'Try again'}
          </button>
        </div>
      ) : null}

      {followError ? (
        <div role="alert" className="card p-4 mb-6 text-[13px] text-[var(--color-error)] border-[var(--color-error)]/30" data-clubs-follow-error>
          {followError}
        </div>
      ) : null}

      {result && !result.ok ? (
        <div className="card card-pad mb-6 text-[14px] text-[var(--color-txt-1)] flex items-start gap-3" data-clubs-degraded>
          <span className="ico">
            <Icon name="info" size={16} />
          </span>
          <p className="m-0 pt-1">
            BoilerLink is not answering right now, so the directory is empty. It usually comes back within a few minutes. You can
            still{' '}
            <a href={BOILERLINK_URL} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] underline underline-offset-[3px]">
              open BoilerLink directly
            </a>
            .
          </p>
        </div>
      ) : null}

      <p className="text-[13px] text-[var(--color-txt-2)] mb-3 min-h-[1rem] tnum" aria-live="polite" data-clubs-results>
        {following
          ? followsData
            ? followingLabel({ total: followingClubs.length, q, category })
            : ''
          : result && result.ok
            ? resultsLabel({ total, q, category, scope })
            : ''}
      </p>

      {showSkeleton ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="card card-pad flex gap-4">
              <div className="skeleton w-14 h-14 shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-3/4" />
                <div className="skeleton h-3 w-full" />
                <div className="skeleton h-3 w-5/6" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          className={`grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6 transition-opacity ${!following && loading ? 'opacity-60' : ''}`}
          aria-busy={!following && loading}
        >
          {shownClubs.map((club) => (
            <ClubCard key={club.id} club={club} scope={following ? 'all' : scope} onCategory={selectCategory} follow={followControl(club)} />
          ))}
        </div>
      )}

      {following && followsData && followingClubs.length === 0 ? (
        <div className="card card-pad mb-6">
          <div className="empty" data-clubs-following-empty>
            <span className="ico">
              <Icon name="users" size={18} />
            </span>
            <p className="text-[14px] text-[var(--color-txt-1)] m-0">
              {followsData?.follows.length === 0
                ? 'You do not follow any clubs yet. Follow one and its events show up under Clubs I follow on Events and Free Food.'
                : followedClubs.length === 0
                  ? 'The clubs you follow are not in the directory right now.'
                  : `None of the clubs you follow match${q ? ` "${q}"` : ''}${category ? ` in ${category}` : ''}.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {followedClubs.length > 0 && (q || category) ? (
                <button type="button" onClick={clearFilters} className="btn btn-secondary btn-sm">
                  Clear filters
                </button>
              ) : (
                <button type="button" onClick={() => updateParams({ following: null })} className="btn btn-primary btn-sm">
                  Browse clubs
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {!following && result && result.ok && !loading && clubs.length === 0 ? (
        <div className="card card-pad mb-6">
          <div className="empty" data-clubs-empty>
            <span className="ico">
              <Icon name="search" size={18} />
            </span>
            <p className="text-[14px] text-[var(--color-txt-1)] m-0">
              No organizations match{q ? ` "${q}"` : ''}
              {category ? ` in ${category}` : ''}
              {scope === 'indianapolis' ? ' in Indianapolis' : ''}.
            </p>
            <div className="flex flex-wrap gap-2">
              {scope === 'indianapolis' ? (
                <button type="button" onClick={() => updateParams({ scope: 'all' })} className="btn btn-primary btn-sm">
                  Search all of Purdue
                </button>
              ) : null}
              {q || category ? (
                <button type="button" onClick={clearFilters} className="btn btn-secondary btn-sm">
                  Clear filters
                </button>
              ) : null}
              <a href={BOILERLINK_URL} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm no-underline">
                Open BoilerLink <Icon name="arrowUpRight" size={12} />
              </a>
            </div>
          </div>
        </div>
      ) : null}

      {canLoadMore ? (
        <div className="flex justify-center mb-8">
          <button
            type="button"
            onClick={() => void search.fetchNextPage()}
            disabled={loadingMore}
            className="btn btn-secondary tnum"
          >
            {loadingMore ? 'Loading' : `Show more (${remaining.toLocaleString()} left)`}
          </button>
        </div>
      ) : null}

      {result ? (
        <p className="text-[12px] leading-relaxed text-[var(--color-txt-3)] max-w-[900px]">
          Directory from{' '}
          <a href={BOILERLINK_URL} target="_blank" rel="noopener noreferrer" className="underline">
            BoilerLink
          </a>
          , Purdue&apos;s student organization hub, refreshed a few times a day{fetched ? ` (last ${fetched})` : ''}. Membership, events
          and contacts live on each organization&apos;s BoilerLink page. Indianapolis groups are the ones that say so in their name or
          description; a Purdue-wide organization may still welcome Indianapolis members.
          {followsData ? ' The clubs you follow are saved with your account, and their events get a Clubs I follow filter on Events and Free Food.' : ''}
        </p>
      ) : null}
    </div>
  )
}
