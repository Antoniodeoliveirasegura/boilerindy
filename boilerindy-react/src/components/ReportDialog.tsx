import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icons'
import StatusBanner from './StatusBanner'
import { authRequest } from '../lib/authApi'
import { MAX_REPORT_DETAILS, REPORT_REASON_OPTIONS, type ReportTargetType } from '../lib/reportReasons'
import { writeFailureMessage } from '../lib/writeFailure'

/**
 * The one report form for everything students post (issue #192), sent to
 * POST /api/reports. A modal on the ConfirmDialog focus rules: focus moves in
 * when it opens, Tab and Shift+Tab stay inside, Escape or the backdrop
 * cancels, and focus goes back to the button that opened it. The reasons are
 * the server's list (lib/reportReasons). Details are asked for when the reason
 * is "Something else" and can be added to any other; the API keeps them
 * optional for every reason. A repeat report is answered as a duplicate,
 * which reads as success here as well. The page owns `open`: both
 * `onReported` and `onClose` expect it to close the dialog.
 */
type ReportDialogProps = {
  open: boolean
  targetType: ReportTargetType
  targetId: string
  /** What is reported, as it reads after "Report": "this post", "Riley". */
  targetLabel: string
  /**
   * Where focus goes when the dialog closes: the Report button that opened it.
   * Without it, whatever had focus at opening, which is <body> or <main> after
   * a click in Safari, where clicking a button does not focus it.
   */
  returnFocusTo?: HTMLElement | null
  onClose: () => void
  onReported: () => void
}

export default function ReportDialog(props: ReportDialogProps) {
  if (!props.open) return null
  // Mounted only while open, so every opening starts with a blank form.
  return <ReportForm key={`${props.targetType}:${props.targetId}`} {...props} />
}

/**
 * The elements Tab stops on inside `root`, in order. A radio group is a single
 * stop, its checked radio or its first while none is, as the browser treats it.
 */
function tabStops(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]'),
  ).filter((el) => el.tabIndex >= 0 && !el.matches(':disabled'))
  return candidates.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio') return true
    const group = candidates.filter(
      (other): other is HTMLInputElement =>
        other instanceof HTMLInputElement && other.type === 'radio' && other.name === el.name,
    )
    return el === (group.find((radio) => radio.checked) ?? group[0])
  })
}

function ReportForm({ targetType, targetId, targetLabel, returnFocusTo, onClose, onReported }: ReportDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [reason, setReason] = useState('')
  const [details, setDetails] = useState('')
  const [addingDetails, setAddingDetails] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  // Focus the first reason on open, and hand focus back to the opener (the
  // Report button) on close instead of dropping it to <body> (issue #221).
  useEffect(() => {
    const previous = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    tabStops(panelRef.current)[0]?.focus()
    return () => {
      previous?.focus()
    }
  }, [returnFocusTo])

  // While a report is on its way the dialog stays open, so its answer lands.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!sending) onClose()
        return
      }
      if (e.key !== 'Tab') return
      const stops = tabStops(panelRef.current)
      if (stops.length === 0) return
      const index = stops.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && index <= 0) {
        e.preventDefault()
        stops[stops.length - 1].focus()
      } else if (!e.shiftKey && (index === -1 || index === stops.length - 1)) {
        e.preventDefault()
        stops[0].focus()
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
  }, [onClose, sending])

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!reason || sending) return
    setSending(true)
    setError('')
    try {
      await authRequest('/api/reports', {
        method: 'POST',
        body: JSON.stringify({ targetType, targetId, reason, details: details.trim() }),
      })
    } catch (err) {
      // A refusal (the target is gone, it is the student's own, the limit)
      // carries the server's message; anything else gets the fallback.
      setError(writeFailureMessage(err, 'Could not send the report. Please try again.'))
      return
    } finally {
      setSending(false)
    }
    onReported()
  }

  // Typed details stay on screen after a switch away from "Something else",
  // so nothing is sent that the student cannot see.
  const showDetails = reason === 'other' || addingDetails || details !== ''

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-dialog-title"
      aria-describedby="report-dialog-message"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
        onClick={() => {
          if (!sending) onClose()
        }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className="relative card w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto p-5 shadow-[var(--shadow-xl)] animate-fade-in-up"
      >
        <form onSubmit={(e) => void submit(e)} data-report-form>
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-[var(--color-stat)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
              <Icon name="flag" size={17} className="text-[var(--color-txt-2)]" />
            </div>
            <div className="min-w-0">
              <h2 id="report-dialog-title" className="text-[15px] font-semibold text-[var(--color-txt-0)] leading-snug break-words">
                Report {targetLabel}
              </h2>
              <p id="report-dialog-message" className="text-[13px] text-[var(--color-txt-2)] mt-1.5 leading-relaxed">
                Our moderators review every report. Only they can see who sent it.
              </p>
            </div>
          </div>
          <fieldset disabled={sending} className="m-0 mt-4 p-0 border-0 min-w-0">
            <legend className="text-[12px] font-semibold text-[var(--color-txt-1)] mb-2 break-words">
              Why are you reporting {targetLabel}?
            </legend>
            <div className="flex flex-col gap-2">
              {REPORT_REASON_OPTIONS.map((r) => (
                <label key={r.value} className="flex items-center gap-2 text-[13px] text-[var(--color-txt-1)] cursor-pointer select-none">
                  <input
                    type="radio"
                    name="report-reason"
                    value={r.value}
                    checked={reason === r.value}
                    onChange={() => setReason(r.value)}
                    className="w-4 h-4 border-[var(--color-border-2)] accent-[var(--color-accent)]"
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </fieldset>
          {showDetails ? (
            <div className="mt-3">
              <label className="block text-[12px] text-[var(--color-txt-2)] mb-1" htmlFor="report-details">
                Tell us more (optional)
              </label>
              <textarea
                id="report-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                maxLength={MAX_REPORT_DETAILS}
                rows={3}
                disabled={sending}
                // Only when the student asked for the box; choosing "Something
                // else" shows it without taking focus off the reasons.
                autoFocus={addingDetails}
                className="input w-full text-[13px] px-3 py-2 resize-y"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingDetails(true)}
              disabled={sending}
              className="mt-3 text-[12px] font-medium text-[var(--color-accent)] hover:underline disabled:opacity-60"
            >
              Add details (optional)
            </button>
          )}
          {error ? (
            <StatusBanner tone="error" className="mt-3">
              {error}
            </StatusBanner>
          ) : null}
          <div className="flex justify-end gap-2 mt-5">
            <button type="button" onClick={onClose} disabled={sending} className="btn btn-secondary text-[13px] px-4 py-2 disabled:opacity-60">
              Cancel
            </button>
            <button type="submit" disabled={!reason || sending} className="btn btn-primary text-[13px] px-4 py-2 disabled:opacity-60">
              {sending ? 'Sending…' : 'Submit report'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
