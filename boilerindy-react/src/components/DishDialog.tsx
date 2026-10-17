import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icons'
import { macroLine, nutritionRows, type MenuItem } from '../lib/dining'
import { useDiningFood } from '../lib/queries/publicData'

// One dish's details (issue #468): what the menu row has opens at once, and
// the photo, whole description, nutrition table and ingredients load from
// GET /api/dining/foods/:id. Only what the feed publishes is shown: no
// placeholder photo or text, and no allergen claims, since the feed has none.

type DishDialogProps = {
  /** The dish to show; null keeps the dialog closed. */
  item: MenuItem | null
  /** The snapshot's date, which the detail read needs. */
  date: string | null
  station?: string
  isFavorite?: boolean
  /** Absent signed out: the star needs an account. */
  onToggleFavorite?: (name: string) => void
  onClose: () => void
  /**
   * Where focus goes on close: the dish's button. Clicking a button does not
   * focus it in Safari, so "whatever had focus" can be the page itself.
   */
  returnFocusTo?: HTMLElement | null
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function DishDialog({ item, date, station, isFavorite = false, onToggleFavorite, onClose, returnFocusTo }: DishDialogProps) {
  const open = item != null
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // An item from a snapshot older than the compact facts has no id: show what it has.
  const detail = useDiningFood(open ? item.id : null, date)

  // Focus moves into the dialog and goes back to the dish's button on close,
  // like ConfirmDialog (issue #221). Both change only when a dish opens or
  // closes, so a re-render while the dialog is up does not move focus.
  useEffect(() => {
    if (!open) return undefined
    const previous = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    closeRef.current?.focus()
    return () => {
      previous?.focus()
    }
  }, [open, returnFocusTo])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
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
  }, [open, onClose])

  if (!open) return null

  const food = detail.data?.food
  const image = food?.image || food?.thumb || item.thumb || null
  const description = food?.description || item.desc || null
  const serving = food?.serving || item.serving || null
  const icons = food?.icons?.length ? food.icons : item.icons || []
  const rows = nutritionRows(food?.nutrition)
  const macros = macroLine(item)
  const facts = [station, serving, item.calories != null ? `${item.calories} cal` : null].filter(Boolean).join(' · ')

  return createPortal(
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 bg-black/55 animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="relative card w-full max-w-lg max-h-[88vh] overflow-y-auto shadow-[var(--shadow-xl)] animate-fade-in-up"
        data-dish-dialog
      >
        {image && (
          <img src={image} alt={item.name} width={1024} height={768} className="block w-full aspect-[4/3] object-cover bg-[var(--color-stat)]" />
        )}
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[20px] leading-tight tracking-[-0.01em] text-[var(--color-txt-0)]">
                {item.name}
              </h2>
              {facts && <p className="mt-1 text-[13px] text-[var(--color-txt-2)] tnum">{facts}</p>}
            </div>
            <div className="flex items-center gap-1 shrink-0 -mr-2 -mt-1">
              {onToggleFavorite && (
                <button
                  type="button"
                  onClick={() => onToggleFavorite(item.name)}
                  aria-pressed={isFavorite}
                  aria-label={isFavorite ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`}
                  className="icon-btn"
                >
                  <Icon name="star" size={17} className={isFavorite ? 'text-[var(--color-txt-0)] fill-current' : 'text-[var(--color-txt-3)]'} />
                </button>
              )}
              <button ref={closeRef} type="button" onClick={onClose} className="icon-btn" aria-label="Close">
                <Icon name="close" size={17} />
              </button>
            </div>
          </div>

          {icons.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {icons.map((ic) => (
                <span key={ic} className="text-[11.5px] leading-none px-2 py-[5px] rounded-[var(--radius-sm)] bg-[var(--color-stat)] text-[var(--color-txt-2)]">
                  {ic}
                </span>
              ))}
            </div>
          )}

          {description && <p className="mt-3 text-[14px] leading-relaxed text-[var(--color-txt-1)]">{description}</p>}

          {rows.main.length > 0 ? (
            <section className="mt-4" aria-label="Nutrition">
              <h3 className="eyebrow bare mb-1.5">Nutrition{serving ? `, per ${serving}` : ''}</h3>
              <table className="w-full text-[13.5px] tnum" data-dish-nutrition>
                <tbody>
                  {rows.main.map((row) => (
                    <tr key={row.key} className="border-t border-[var(--color-border)] first:border-t-0">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal text-[var(--color-txt-1)]">
                        {row.label}
                      </th>
                      <td className="py-1.5 text-right font-semibold text-[var(--color-txt-0)]">{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.minor.length > 0 && (
                <p className="mt-2 text-[12.5px] text-[var(--color-txt-2)] tnum">
                  {rows.minor.map((row) => `${row.label} ${row.value}`).join(' · ')}
                </p>
              )}
            </section>
          ) : (
            macros && <p className="mt-4 text-[13px] text-[var(--color-txt-2)] tnum">{macros}</p>
          )}

          {food?.ingredients && (
            <section className="mt-4">
              <h3 className="eyebrow bare mb-1">Ingredients</h3>
              <p className="text-[13.5px] leading-relaxed text-[var(--color-txt-1)]">{food.ingredients}</p>
            </section>
          )}

          {item.id != null && detail.isPending && (
            <p className="mt-4 text-[13px] text-[var(--color-txt-2)]" data-dish-loading>
              Loading nutrition and ingredients…
            </p>
          )}
          {item.id != null && detail.isError && (
            <p role="alert" className="mt-4 text-[13px] text-[var(--color-txt-1)]">
              Could not load the full details.{' '}
              <button type="button" onClick={() => void detail.refetch()} className="prose-link">
                Try again
              </button>
            </p>
          )}

          <p className="mt-4 text-[12px] leading-snug text-[var(--color-txt-3)]">
            Nutrition and ingredients are as the dining menu feed publishes them, and some values are wrong. The feed lists no
            allergens: ask dining staff about allergies.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
