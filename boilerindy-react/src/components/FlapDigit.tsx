import { useCallback, useState, type CSSProperties } from 'react'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { canAnimate } from '../lib/motion'

type FlapDigitProps = {
  value: string
  /** The tile's place on its board, for the --motion-stagger between tiles. */
  index?: number
  className?: string
}

type Roll = { value: string; from: string | null; turn: number }

/**
 * One split-flap tile of a departures board: Home's Next class and the Landing
 * preview (docs/motion.md). When its digit changes, and when the tile first
 * shows one, the old digit rolls up out of the tile and the new one rolls in
 * (index.css .flap-roll, the app's rolling digits), a --motion-stagger later
 * per tile. With Reduce Motion, or without the Web Animations API (the unit
 * tests), the new digit is simply there.
 */
export default function FlapDigit({ value, index = 0, className = '' }: FlapDigitProps) {
  const reduced = usePrefersReducedMotion()
  const rolls = !reduced && canAnimate()
  // A first showing rolls in from a blank tile ('').
  const [roll, setRoll] = useState<Roll>(() => ({ value, from: rolls ? '' : null, turn: 0 }))
  if (roll.value !== value) {
    setRoll({ value, from: rolls ? roll.value : null, turn: roll.turn + 1 })
  }
  const from = rolls ? roll.from : null
  // The roll's end puts the tile at rest. A native listener, since React
  // names the event after the browser's prefix (webkitAnimationEnd in jsdom).
  const atRest = useCallback((strip: HTMLSpanElement | null) => {
    if (!strip) return undefined
    const settle = () => setRoll((r) => ({ ...r, from: null }))
    strip.addEventListener('animationend', settle)
    return () => strip.removeEventListener('animationend', settle)
  }, [])

  return (
    <span className={`flap ${className}`} aria-hidden="true">
      <span className={from === null ? undefined : 'invisible'}>{value}</span>
      {from !== null && (
        <span
          key={roll.turn}
          ref={atRest}
          className="flap-roll"
          style={{ '--flap-i': index } as CSSProperties}
          data-testid="flap-roll"
        >
          <span>
            <span>{from || ' '}</span>
            <span>{value}</span>
          </span>
        </span>
      )}
    </span>
  )
}
