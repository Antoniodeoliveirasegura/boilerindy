import type { EventSourceCount, SourceFilter } from '../lib/campusEvents'

// The source pills on Events and Free Food (issue #30): every source, or only
// Purdue's calendars, IU's or the student's own. Shown only when the rows come
// from two sources or more (lib/campusEvents.eventSourceCounts).
export default function EventSourceFilter({
  counts,
  value,
  onChange,
}: {
  counts: EventSourceCount[]
  value: SourceFilter
  onChange: (next: SourceFilter) => void
}) {
  if (counts.length < 2) return null
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
      {counts.map((source) => (
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
    </div>
  )
}
