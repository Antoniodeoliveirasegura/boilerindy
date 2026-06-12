import { useState } from 'react'
import Icon from '../Icons'

/**
 * One slot in the customizable home dashboard grid (issue #52).
 *
 * Outside edit mode it is a transparent pass-through: it renders the widget's
 * existing card JSX untouched, only applying the wide column span. In edit mode
 * it adds a toolbar (drag handle + keyboard move up/down + hide) and wires up
 * native HTML drag-and-drop. The widget body is made non-interactive while
 * editing so dragging a card never accidentally follows a link inside it.
 *
 * Keyboard users reorder with the up/down buttons (native DnD is pointer-only),
 * so the feature stays fully operable without a mouse.
 */
export default function DashboardWidget({
  id,
  title,
  editing,
  isWide,
  canMoveUp,
  canMoveDown,
  onMove,
  onHide,
  onDropReorder,
  reducedMotion,
  children,
}) {
  const [dragOver, setDragOver] = useState(false)

  const spanClass = isWide ? 'lg:col-span-2' : ''

  if (!editing) {
    return (
      <div className={spanClass} data-widget-id={id}>
        {children}
      </div>
    )
  }

  const motionClass = reducedMotion ? '' : 'transition-shadow'

  return (
    <div
      className={`relative ${spanClass}`}
      data-widget-id={id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', id)
      }}
      onDragEnd={() => setDragOver(false)}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the widget bounds.
        if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const fromId = e.dataTransfer.getData('text/plain')
        if (fromId) onDropReorder(fromId, id)
      }}
    >
      <div
        className={`absolute inset-0 z-10 rounded-2xl border-2 border-dashed pointer-events-none ${motionClass} ${
          dragOver
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
            : 'border-[var(--color-border-2)]'
        }`}
      />
      <div className="relative z-20 flex items-center justify-between gap-2 mb-2 px-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--color-stat)] border border-[var(--color-border)] text-[var(--color-txt-3)] cursor-grab active:cursor-grabbing shrink-0"
            aria-hidden="true"
            title="Drag to reorder"
          >
            <Icon name="menu" size={14} />
          </span>
          <span className="text-[12px] font-semibold text-[var(--color-txt-1)] truncate">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onMove(id, -1)}
            disabled={!canMoveUp}
            aria-label={`Move ${title} up`}
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-txt-2)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]/40 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Icon name="chevronUp" size={14} />
          </button>
          <button
            type="button"
            onClick={() => onMove(id, 1)}
            disabled={!canMoveDown}
            aria-label={`Move ${title} down`}
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-txt-2)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]/40 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Icon name="chevronDown" size={14} />
          </button>
          <button
            type="button"
            onClick={() => onHide(id)}
            aria-label={`Hide ${title}`}
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-txt-2)] hover:text-[var(--color-error)] hover:border-[var(--color-error)]/40"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      {/* Non-interactive preview of the real widget while arranging. */}
      <div className="pointer-events-none select-none opacity-90">{children}</div>
    </div>
  )
}
