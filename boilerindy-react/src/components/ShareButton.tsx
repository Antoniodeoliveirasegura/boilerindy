import { useEffect, useId, useRef, useState } from 'react'
import Icon from './Icons'
import { track } from '../lib/usageStats'
import type { SharePage } from '../lib/shareLinks'

// The Share button on /transit, /dining and /free-food (docs/share-links.md).
// A phone or tablet opens the system share sheet, which goes straight to a
// group chat. A laptop copies the link and says so: its share sheet, where it
// has one, is slower than pasting. A clipboard that refuses (some in-app
// browsers do) shows the link in a field to copy by hand.

const COPIED_MS = 2500

type ShareButtonProps = {
  /** The page shared, for the share_clicked event. */
  page: SharePage
  /** Builds the link when the button is pressed, so it carries the view on screen then. */
  getUrl: () => string
  /** The share sheet's title and message. */
  title: string
  text: string
  /** One listing shared rather than the page (an event on /free-food), recorded with share_clicked. */
  kind?: 'event'
  /** The button's name where a page has a Share per listing ("Share Boiler Fuel Up"); its text stays "Share". */
  label?: string
  /** A small text button in a listing's row, rather than the header's. */
  inline?: boolean
}

// A coarse pointer is a touch screen: a phone or a tablet.
function opensShareSheet(data: ShareData): boolean {
  if (typeof navigator.share !== 'function') return false
  if (typeof navigator.canShare === 'function' && !navigator.canShare(data)) return false
  return window.matchMedia('(pointer: coarse)').matches
}

export default function ShareButton({ page, getUrl, title, text, kind, label, inline = false }: ShareButtonProps) {
  // When the link was last copied; the label says so for a moment after.
  const [copiedAt, setCopiedAt] = useState<number | null>(null)
  // The link to copy by hand, after the clipboard refused it.
  const [manualUrl, setManualUrl] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const fieldId = useId()

  useEffect(() => {
    if (copiedAt === null) return
    const timer = window.setTimeout(() => setCopiedAt(null), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copiedAt])

  function copy(url: string) {
    const written = navigator.clipboard?.writeText(url)
    if (!written) {
      setManualUrl(url)
      return
    }
    written.then(
      () => {
        setManualUrl(null)
        setCopiedAt(Date.now())
      },
      () => setManualUrl(url),
    )
  }

  function share() {
    const url = getUrl()
    track('share_clicked', kind ? { page, kind } : { page })
    const data = { title, text, url }
    if (!opensShareSheet(data)) {
      copy(url)
      return
    }
    // Closing the sheet without sharing rejects with AbortError, which needs
    // nothing. Any other refusal copies the link instead.
    navigator.share(data).catch((error: unknown) => {
      if ((error as { name?: unknown } | null)?.name !== 'AbortError') copy(url)
    })
  }

  function closeManual() {
    setManualUrl(null)
    buttonRef.current?.focus()
  }

  const copied = copiedAt !== null

  return (
    <>
      {/* The label names the listing until the link is copied, when the
          text says so. */}
      <button
        ref={buttonRef}
        type="button"
        onClick={share}
        aria-label={label && !copied ? label : undefined}
        className={
          inline
            ? '-my-1 inline-flex items-center gap-1 whitespace-nowrap py-1 text-[13px] text-[var(--color-accent)] hover:underline underline-offset-[3px]'
            : 'btn btn-secondary whitespace-nowrap'
        }
        data-share={page}
      >
        <Icon name={copied ? 'check' : 'share'} size={inline ? 12 : 15} />
        {copied ? 'Link copied' : 'Share'}
      </button>
      {/* A live region without the status role: the pages have their own
          status notices (a stale feed, say), and this one is only a word. */}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Link copied to the clipboard' : ''}
      </span>
      {/* Fixed under the top bar rather than hung off the button: on a phone
          the header's buttons wrap to the left edge, where a popover would
          run off the screen. Above the map's own controls (z 1000). */}
      {manualUrl && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes the dialog from either control inside it
        <div
          role="dialog"
          aria-label="Share link"
          className="card fixed left-1/2 top-20 z-[1050] w-[min(360px,calc(100vw-32px))] -translate-x-1/2 p-3 shadow-[var(--shadow-lg)]"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeManual()
          }}
          data-share-manual
        >
          <label htmlFor={fieldId} className="mb-1.5 block text-[12.5px] text-[var(--color-txt-2)]">
            Copy this link to share it
          </label>
          <input
            id={fieldId}
            type="text"
            readOnly
            value={manualUrl}
            autoFocus
            onFocus={(e) => e.target.select()}
            className="input font-mono text-[13px] max-sm:text-[16px]"
          />
          <button type="button" onClick={closeManual} className="btn btn-ghost btn-sm -ml-3 mt-2">
            Done
          </button>
        </div>
      )}
    </>
  )
}
