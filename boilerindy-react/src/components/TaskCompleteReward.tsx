import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import type { RewardOrigin } from '../lib/rewardOrigin'

type Burst = RewardOrigin & { id: number }

const PARTICLE_COUNT = 8
const BURST_MS = 900
const TOAST_MS = 1400

/**
 * Floating check-off reward: particle burst at the click point + a brief toast.
 * Renders via portal so the animation still plays if the row hides immediately.
 */
export default function TaskCompleteReward({
  origin,
  onDone,
}: {
  origin: RewardOrigin | null
  onDone?: () => void
}) {
  const reducedMotion = usePrefersReducedMotion()
  const [burst, setBurst] = useState<Burst | null>(null)
  const [toast, setToast] = useState(false)
  // Kept in a ref so the timers below always call the latest onDone without
  // restarting the animation when the parent re-renders; written in an effect,
  // not during render (react-hooks/refs).
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    if (!origin) return undefined

    if (reducedMotion) {
      setToast(true)
      const t = window.setTimeout(() => {
        setToast(false)
        onDoneRef.current?.()
      }, 700)
      return () => window.clearTimeout(t)
    }

    const id = Date.now()
    setBurst({ id, x: origin.x, y: origin.y })
    setToast(true)

    const burstTimer = window.setTimeout(() => setBurst(null), BURST_MS)
    const toastTimer = window.setTimeout(() => {
      setToast(false)
      onDoneRef.current?.()
    }, TOAST_MS)

    return () => {
      window.clearTimeout(burstTimer)
      window.clearTimeout(toastTimer)
    }
  }, [origin, reducedMotion])

  if (typeof document === 'undefined') return null

  return createPortal(
    <>
      {burst ? (
        <div
          className="task-reward-burst"
          style={{ left: burst.x, top: burst.y }}
          aria-hidden="true"
        >
          <span className="task-reward-burst__ring" />
          {Array.from({ length: PARTICLE_COUNT }, (_, i) => (
            <span
              key={`${burst.id}-${i}`}
              className="task-reward-burst__particle"
              style={{ '--i': i } as CSSProperties}
            />
          ))}
        </div>
      ) : null}
      {toast ? (
        <div className="task-reward-toast" role="status" aria-live="polite">
          <span className="task-reward-toast__check" aria-hidden="true">
            ✓
          </span>
          Nice - one less thing
        </div>
      ) : null}
    </>,
    document.body,
  )
}
