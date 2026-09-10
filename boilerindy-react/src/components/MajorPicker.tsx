import { useEffect, useMemo, useRef, useState } from 'react'
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
    <span
      title={degreeLabels[degree] || degree}
      className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold tracking-wide bg-[var(--color-stat)] border border-[var(--color-border)] text-[var(--color-txt-2)]"
    >
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
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid="major-picker"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex-1 min-w-0 flex items-center gap-2 py-2 px-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] text-left outline-none transition-colors hover:border-[var(--color-border-2)] focus-visible:border-[var(--color-gold)] focus-visible:ring-2 focus-visible:ring-[var(--color-gold)]/20"
        >
          <Icon name="graduation" size={15} className="text-[var(--color-txt-3)] shrink-0" />
          <span
            className={`flex-1 min-w-0 truncate ${
              selected ? 'text-[var(--color-txt-0)]' : 'text-[var(--color-txt-3)]'
            }`}
          >
            {selected ? selected.name : 'Select your major…'}
          </span>
          {selected && <DegreeBadge degree={selected.degree} />}
          <Icon
            name={open ? 'chevronUp' : 'chevronDown'}
            size={15}
            className="text-[var(--color-txt-3)] shrink-0"
          />
        </button>
        {selected && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear selected major"
            className="w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-lg text-[var(--color-txt-3)] hover:text-[var(--color-error)] hover:bg-[var(--color-stat)] transition-colors"
          >
            <Icon name="close" size={15} />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
            <Icon name="search" size={14} className="text-[var(--color-txt-3)] shrink-0" />
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
              className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--color-txt-0)] outline-none placeholder:text-[var(--color-txt-3)]"
            />
            <span className="text-[11px] text-[var(--color-txt-3)] shrink-0 tabular-nums">
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
              <div className="px-3 py-6 text-center text-[12px] text-[var(--color-txt-2)]">
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
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors ${
                      index === activeIndex ? 'bg-[var(--color-stat)]' : ''
                    }`}
                  >
                    <span
                      className={`w-4 shrink-0 ${
                        isSelected ? 'text-[var(--color-gold)]' : 'text-transparent'
                      }`}
                    >
                      <Icon name="check" size={14} />
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[var(--color-txt-0)]">
                      {option.name}
                    </span>
                    {option.tracked && (
                      <span
                        title="Requirements are mapped for this major"
                        className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-[var(--color-gold)]/15 text-[var(--color-gold)] border border-[var(--color-gold)]/30"
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
