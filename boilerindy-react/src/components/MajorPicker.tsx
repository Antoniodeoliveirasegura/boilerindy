import { useEffect, useMemo, useRef, useState } from 'react'
import { usePresence } from '../hooks/usePresence'
import Icon from './Icons'
import { listPrograms } from '../../../src/degreePrograms.mjs'
import { DEGREE_LABELS } from '../../../src/purdueMajors.mjs'

/**
 * Searchable major selector for the degree planner. A native <select> was fine
 * for the three curated programs, but the list is now every Purdue
 * undergraduate major (~300), which needs type-to-filter, keyboard navigation
 * and a way to clear the choice.
 */
export type MajorOption = {
  id: string
  name: string
  degree: string
  /** True when we have curated requirement data to check off. */
  tracked: boolean
}

type MajorPickerProps = {
  value: string | null
  onChange: (id: string | null) => void
}

const degreeLabels = DEGREE_LABELS as Record<string, string | undefined>

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Substring match on the major name and degree, ranked so the most obvious hit
 * lands first: name prefix, then word-start, then anywhere.
 */
function rank(option: MajorOption, query: string): number {
  const name = normalize(option.name)
  if (name.startsWith(query)) return 0
  if (name.includes(` ${query}`)) return 1
  if (name.includes(query)) return 2
  if (normalize(option.degree).startsWith(query)) return 3
  return -1
}

function DegreeBadge({ degree }: { degree: string }) {
  return (
    <span title={degreeLabels[degree] || degree} className="badge shrink-0">
      {degree}
    </span>
  )
}

export default function MajorPicker({ value, onChange }: MajorPickerProps) {
  const options = useMemo(() => listPrograms() as MajorOption[], [])
  const selected = useMemo(() => options.find((o) => o.id === value) || null, [options, value])

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The dropdown plays its exit before it leaves the page (docs/motion.md).
  const dropdown = usePresence(open)

  const results = useMemo(() => {
    const q = normalize(query)
    if (!q) return options
    return options
      .map((option) => ({ option, score: rank(option, q) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => a.score - b.score || a.option.name.localeCompare(b.option.name))
      .map((r) => r.option)
  }, [options, query])

  // Open with the current major highlighted so Enter is a no-op rather than a
  // surprise change.
  useEffect(() => {
    if (!open) return
    setQuery('')
    const index = value ? options.findIndex((o) => o.id === value) : 0
    setActiveIndex(index < 0 ? 0 : index)
    inputRef.current?.focus()
  }, [open, options, value])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open])

  // Keep the highlighted row visible while arrowing through ~300 majors.
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const commit = (option: MajorOption) => {
    onChange(option.id)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((i) => (i + delta + results.length) % results.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const option = results[activeIndex]
      if (option) commit(option)
    }
  }

  return (
    <div ref={wrapRef} className="relative w-full sm:w-[22rem]">
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="major-picker"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="input flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-[14px]"
        >
          <Icon name="graduation" size={16} className="shrink-0 text-[var(--color-txt-2)]" />
          <span
            className={`min-w-0 flex-1 truncate ${
              selected ? 'font-display font-bold text-[var(--color-txt-0)]' : 'text-[var(--color-txt-3)]'
            }`}
          >
            {selected ? selected.name : 'Select your major…'}
          </span>
          {selected && <DegreeBadge degree={selected.degree} />}
          <Icon
            name={open ? 'chevronUp' : 'chevronDown'}
            size={16}
            className="shrink-0 text-[var(--color-txt-2)]"
          />
        </button>
        {selected && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear selected major"
            className="icon-btn shrink-0 hover:text-[var(--color-error)]"
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </div>

      {dropdown.mounted && (
        <div
          ref={dropdown.ref}
          data-motion={dropdown.motion}
          inert={!open}
          className="menu-panel motion-pop origin-top absolute z-50 mt-1.5 w-full overflow-hidden p-0"
        >
          <div className="relative border-b border-[var(--color-border)] p-2">
            <Icon
              name="search"
              size={15}
              className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-[var(--color-txt-3)]"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={onKeyDown}
              placeholder="Search all Purdue majors…"
              aria-label="Search majors"
              role="combobox"
              aria-expanded={open}
              aria-controls="major-picker-list"
              className="input min-h-[44px] py-2 pl-9 pr-12 text-[14px] md:min-h-[40px]"
            />
            <span className="tnum pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 font-display text-[12px] font-bold text-[var(--color-txt-3)]">
              {results.length}
            </span>
          </div>

          <div
            ref={listRef}
            id="major-picker-list"
            role="listbox"
            aria-label="Purdue majors"
            className="max-h-[18rem] overflow-y-auto overscroll-contain py-1"
          >
            {results.length === 0 ? (
              <div className="px-3 py-6 text-center text-[13px] text-[var(--color-txt-2)]">
                No major matches “{query}”.
              </div>
            ) : (
              results.map((option, index) => {
                const isSelected = option.id === value
                return (
                  <button
                    key={option.id}
                    type="button"
                    data-index={index}
                    data-major-id={option.id}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(option)}
                    className={`flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-[14px] transition-colors md:min-h-[40px] ${
                      index === activeIndex ? 'bg-[var(--color-bg-2)]' : ''
                    }`}
                  >
                    <span
                      className={`w-4 shrink-0 ${
                        isSelected ? 'text-[var(--color-txt-0)]' : 'text-transparent'
                      }`}
                    >
                      <Icon name="check" size={14} strokeWidth={2.5} />
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-[var(--color-txt-0)] ${
                        isSelected ? 'font-display font-bold' : ''
                      }`}
                    >
                      {option.name}
                    </span>
                    {option.tracked && (
                      <span
                        title="Requirements are mapped for this major"
                        className="badge badge-route shrink-0"
                      >
                        Plan
                      </span>
                    )}
                    <DegreeBadge degree={option.degree} />
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
