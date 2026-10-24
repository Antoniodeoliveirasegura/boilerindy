import type { EventSourceCount, SourceFilter } from '../lib/campusEvents'

// The source pills on Events and Free Food (issue #30): every source, or only
// Purdue's calendars, IU's or the student's own. Shown only when the rows come
// from two sources or more (lib/campusEvents.eventSourceCounts). Beside them,
// "Clubs I follow" (issue #16) narrows the list to the events of the clubs the
// student follows on /clubs. It shows whenever `followedCount` is a number,
// which only a signed-in read from a server that marks follows gives
// (lib/campusEvents.followedEventCount), even at 0: its empty state says where
// to follow clubs.
export default function EventSourceFilter({
  counts,
  value,
  onChange,
  followedCount = null,
}: {
  counts: EventSourceCount[]
  value: SourceFilter
  onChange: (next: SourceFilter) => void
  followedCount?: number | null
}) {
  const showSources = counts.length >= 2
  const showFollowing = followedCount !== null
  if (!showSources && !showFollowing) return null
  return (
    <div role="group" aria-label="Event source" className="flex flex-wrap gap-2 mb-3">
      <button
        type="button"
        onClick={() => onChange('all')}
        aria-pressed={value === 'all'}
        className={`pill whitespace-nowrap ${value === 'all' ? 'pill-active' : ''}`}
      >
        All sources
      </button>
      {showSources &&
        counts.map((source) => (
          <button
            key={source.id}
            type="button"
            onClick={() => onChange(source.id)}
            aria-pressed={value === source.id}
            className={`pill whitespace-nowrap tnum ${value === source.id ? 'pill-active' : ''}`}
          >
            {source.label} ({source.count})
          </button>
        ))}
      {showFollowing && (
        <button
          type="button"
          onClick={() => onChange('following')}
          aria-pressed={value === 'following'}
          className={`pill whitespace-nowrap tnum ${value === 'following' ? 'pill-active' : ''}`}
        >
          Clubs I follow ({followedCount})
        </button>
      )}
    </div>
  )
}
