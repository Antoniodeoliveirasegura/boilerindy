import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
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

  useEffect(() => {
    if (!open) return undefined
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
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

  if (!open) return null

  const confirmTone =
    tone === 'danger'
      ? 'text-white bg-[var(--color-error)] border border-[var(--color-error)] hover:opacity-90'
      : 'btn-primary'

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby={message ? 'confirm-dialog-message' : undefined}
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div className="relative card w-full max-w-sm p-5 shadow-[var(--shadow-xl)] animate-fade-in-up">
        <div className="flex items-start gap-3">
          {icon && (
            <div className="w-9 h-9 rounded-xl bg-[var(--color-stat)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
              <Icon name={icon} size={17} className="text-[var(--color-txt-2)]" />
            </div>
          )}
          <div className="min-w-0">
            <h2 id="confirm-dialog-title" className="text-[15px] font-semibold text-[var(--color-txt-0)] leading-snug">
              {title}
            </h2>
            {message && (
              <p id="confirm-dialog-message" className="text-[13px] text-[var(--color-txt-2)] mt-1.5 leading-relaxed">
                {message}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onCancel} className="btn btn-secondary text-[13px] px-4 py-2">
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`btn text-[13px] px-4 py-2 ${confirmTone}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
