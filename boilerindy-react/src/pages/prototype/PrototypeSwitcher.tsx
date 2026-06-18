// PROTOTYPE — floating design switcher. Fixed bottom-centre pill: prev/next
// arrows + the current variant key & name, kept in the ?variant= URL param so a
// design is shareable and survives reload. Arrow keys cycle too (ignored while
// typing). Dev-only. Throwaway — delete with src/pages/prototype/.
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

export type VariantMeta = { key: string; label: string }

type Props = {
  variants: VariantMeta[]
  current: string
}

export default function PrototypeSwitcher({ variants, current }: Props) {
  const [, setSearchParams] = useSearchParams()
  const idx = Math.max(0, variants.findIndex((v) => v.key === current))
  const meta = variants[idx]

  // Jump to a variant by (wrapped) index. Plain-object form — no functional
  // updater — so there's no stale `prev` param to reason about.
  const goTo = (i: number) => {
    const nextKey = variants[(i + variants.length) % variants.length].key
    setSearchParams({ variant: nextKey }, { replace: true })
  }

  // Bind the keydown listener once, but read the live index from a ref so it
  // never captures a stale closure (an [] effect closing over the first render's
  // index made every press cycle from A regardless of the current variant).
  const idxRef = useRef(idx)
  idxRef.current = idx
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goTo(idxRef.current - 1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goTo(idxRef.current + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!import.meta.env.DEV) return null

  const arrow =
    'w-9 h-9 inline-flex items-center justify-center rounded-full text-lg text-white/90 ' +
    'hover:bg-white/15 active:scale-90 transition'

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 bottom-5 z-[1000] flex items-center gap-1 rounded-full px-2 py-1.5"
      style={{
        background: 'rgba(17,17,19,0.92)',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow: '0 10px 40px rgba(0,0,0,0.45)',
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <button type="button" onClick={() => goTo(idx - 1)} className={arrow} aria-label="Previous design">←</button>
      <div className="px-3 text-center leading-tight select-none min-w-[150px]">
        <div className="text-[13px] font-semibold text-white">
          <span style={{ color: '#E6C77A' }}>{meta.key}</span> · {meta.label}
        </div>
        <div className="text-[10px] text-white/45 tracking-wide">
          design {idx + 1} / {variants.length} · ← → to switch
        </div>
      </div>
      <button type="button" onClick={() => goTo(idx + 1)} className={arrow} aria-label="Next design">→</button>
    </div>
  )
}
