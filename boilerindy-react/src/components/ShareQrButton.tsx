import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icons'
import { usePresence } from '../hooks/usePresence'
import { qrCodePath } from '../lib/qrCode'
import { shareUrl, type SharePage } from '../lib/shareLinks'
import { track } from '../lib/usageStats'

// The QR button beside Share on /transit, /dining and /free-food
// (docs/share-links.md, "The QR code"). It shows the view on screen as a QR
// code, for a friend standing there to scan with their camera, or to move the
// page from a laptop to a phone. The code carries the page's QR ref (qr-bus),
// so a sign-up from a scan counts apart from one from a chat; the link under
// it, for a chat after all, keeps the share ref (share-bus).

const COPIED_MS = 2500
// White modules around the code, as the QR standard asks, so a camera finds its edge.
const QUIET_ZONE = 4
const FOCUSABLE = 'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'

type ShareQrButtonProps = {
  /** The page shared, for the share_clicked event and the QR ref. */
  page: SharePage
  /** The Share button's link, built when the QR opens, so the code carries the view on screen then. */
  getUrl: () => string
  /** The Share button's message, the dialog's heading: what the code opens. */
  text: string
}

export default function ShareQrButton({ page, getUrl, text }: ShareQrButtonProps) {
  // The share link the dialog shows; null while it is closed.
  const [link, setLink] = useState<string | null>(null)
  const open = link !== null
  // Closing plays the exit before the dialog leaves the page (docs/motion.md),
  // still showing the code the button has already let go of.
  const { attach, mounted, motion } = usePresence(open)
  const [shownLink, setShownLink] = useState(link)
  if (link && link !== shownLink) setShownLink(link)
  const current = link ?? shownLink
  const qr = useMemo(() => (current ? qrCodePath(shareUrl(page, current, {}, 'qr')) : null), [page, current])

  // When the link was last copied; the button says so for a moment after.
  const [copiedAt, setCopiedAt] = useState<number | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const doneRef = useRef<HTMLButtonElement | null>(null)
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const hintId = useId()
  const fieldId = useId()

  useEffect(() => {
    if (copiedAt === null) return
    const timer = window.setTimeout(() => setCopiedAt(null), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copiedAt])

  // Focus moves to Done while the dialog is open and goes back to the QR
  // button on close, like ConfirmDialog (issue #221). The button itself, not
  // whatever had focus: clicking a button does not focus it in Safari.
  useEffect(() => {
    if (!open) return undefined
    const opener = buttonRef.current
    doneRef.current?.focus()
    return () => {
      opener?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setLink(null)
        return
      }
      // Keep Tab inside the dialog.
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  function show() {
    const url = getUrl()
    track('share_clicked', { page, via: 'qr' })
    setCopiedAt(null)
    setLink(url)
  }

  // A clipboard that refuses (some in-app browsers do) selects the link
  // instead, to copy by hand.
  function copy() {
    if (!current) return
    const written = navigator.clipboard?.writeText(current)
    if (!written) {
      fieldRef.current?.focus()
      return
    }
    written.then(
      () => setCopiedAt(Date.now()),
      () => fieldRef.current?.focus(),
    )
  }

  const copied = copiedAt !== null
  const span = qr ? qr.size + QUIET_ZONE * 2 : 0

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={show}
        aria-label="Show QR code"
        aria-haspopup="dialog"
        title="Show QR code"
        className="btn btn-secondary w-11 md:w-10 px-0"
        data-share-qr={page}
      >
        <Icon name="qr" size={15} />
      </button>
      {mounted &&
        current &&
        qr &&
        createPortal(
          <div
            ref={attach}
            data-motion={motion}
            inert={!open}
            className="fixed inset-0 z-[2000] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={hintId}
            data-share-qr-dialog
          >
            <div className="motion-scrim absolute inset-0 bg-black/55" onClick={() => setLink(null)} aria-hidden="true" />
            <div
              ref={panelRef}
              className="motion-sheet relative card w-full max-w-sm max-h-[calc(100dvh-32px)] overflow-y-auto p-5 shadow-[var(--shadow-xl)]"
            >
              <h2 id={titleId} className="text-[17px] tracking-[-0.01em] text-[var(--color-txt-0)] leading-snug">
                {text}
              </h2>
              <p id={hintId} className="text-[14px] text-[var(--color-txt-2)] mt-1.5 leading-relaxed">
                Point a phone&apos;s camera at the code to open it. No account needed.
              </p>
              {/* Black on white in either theme: not every camera reads a
                  light code on a dark ground. */}
              <svg
                role="img"
                aria-label="QR code"
                viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${span} ${span}`}
                shapeRendering="crispEdges"
                className="mx-auto mt-4 block aspect-square w-full max-w-[288px] rounded-[var(--radius-xl)]"
                data-share-qr-code
              >
                <rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={span} height={span} fill="#fff" />
                <path d={qr.d} fill="#000" />
              </svg>
              <label htmlFor={fieldId} className="mt-4 mb-1.5 block text-[12.5px] text-[var(--color-txt-2)]">
                Or send the link
              </label>
              <div className="flex gap-2">
                <input
                  ref={fieldRef}
                  id={fieldId}
                  type="text"
                  readOnly
                  value={current}
                  onFocus={(e) => e.target.select()}
                  className="input min-w-0 flex-1 font-mono text-[13px] max-sm:text-[16px]"
                />
                <button type="button" onClick={copy} className="btn btn-secondary whitespace-nowrap">
                  <Icon name={copied ? 'check' : 'copy'} size={15} />
                  {copied ? 'Link copied' : 'Copy link'}
                </button>
              </div>
              <span aria-live="polite" className="sr-only">
                {copied ? 'Link copied to the clipboard' : ''}
              </span>
              <div className="flex justify-end mt-4">
                <button ref={doneRef} type="button" onClick={() => setLink(null)} className="btn btn-primary">
                  Done
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
