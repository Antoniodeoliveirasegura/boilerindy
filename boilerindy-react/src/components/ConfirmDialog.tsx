import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePresence } from '../hooks/usePresence'
import Icon from './Icons'

/**
 * Reusable, app-styled confirmation modal - a replacement for the native
 * window.confirm() (which renders as an ugly browser dialog). Rendered through a
 * portal so it escapes any parent overflow/stacking context. Confirms on the
 * focused primary button, cancels on Escape or backdrop click.
 */
type ConfirmDialogProps = {
  open: boolean
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 'danger' tints the confirm button as a destructive action. */
  tone?: 'default' | 'danger'
  /** Optional icon name (from the Icons set) shown beside the title. */
  icon?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  icon,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Closing plays the exit before the dialog leaves the page; focus, the Tab
  // trap and the scroll lock below already let go when `open` turns false.
  const presence = usePresence(open)

  // Focus moves into the dialog while it is open and goes back afterwards
  // (issue #221): the element that had focus when the dialog opened, usually
  // the button that asked for confirmation, gets it again on close instead of
  // focus dropping to <body>. Keyed on `open` alone so a parent re-render
  // while the dialog is up does not re-run it.
  useEffect(() => {
    if (!open) return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    confirmRef.current?.focus()
    return () => {
      previous?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
        return
      }
      // Two-button focus trap: Tab and Shift+Tab move between Cancel and
      // Confirm and never leave the dialog for the page underneath.
      if (e.key === 'Tab') {
        e.preventDefault()
        const next = document.activeElement === confirmRef.current ? cancelRef.current : confirmRef.current
        next?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    // Lock background scroll while the dialog is open.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onCancel])

  if (!presence.mounted) return null

  const confirmTone =
    tone === 'danger'
      ? 'text-[var(--color-on-route)] bg-[var(--color-error)] border-[var(--color-error)] hover:opacity-90'
      : 'btn-primary'

  return createPortal(
    <div
      ref={presence.ref}
      data-motion={presence.motion}
      inert={!open}
      className="fixed inset-0 z-[2000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby={message ? 'confirm-dialog-message' : undefined}
    >
      <div
        className="motion-scrim absolute inset-0 bg-black/55"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div className="motion-sheet relative card w-full max-w-sm p-5 shadow-[var(--shadow-xl)]">
        <div className="flex items-start gap-3">
          {icon && (
            <div className={`route-badge shrink-0 ${tone === 'danger' ? 'bg-[var(--color-error)] text-[var(--color-on-route)]' : 'r-ink'}`}>
              <Icon name={icon} size={17} />
            </div>
          )}
          <div className="min-w-0">
            <h2 id="confirm-dialog-title" className="text-[17px] tracking-[-0.01em] text-[var(--color-txt-0)] leading-snug">
              {title}
            </h2>
            {message && (
              <p id="confirm-dialog-message" className="text-[14px] text-[var(--color-txt-2)] mt-1.5 leading-relaxed">
                {message}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button ref={cancelRef} type="button" onClick={onCancel} className="btn btn-secondary">
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`btn ${confirmTone}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
