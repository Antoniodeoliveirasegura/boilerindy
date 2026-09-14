import type { MouseEvent as ReactMouseEvent } from 'react'

// Where the task-complete reward animation starts (TaskCompleteReward). Lives
// outside the component file so that file exports only components and React
// Fast Refresh keeps working for it (issue #183, react-refresh/only-export-components).

export type RewardOrigin = { x: number; y: number }

/** Prefer the checkbox center; fall back to the click point. */
export function rewardOriginFromEvent(e?: ReactMouseEvent | null): RewardOrigin {
  const target = e?.currentTarget
  if (target instanceof HTMLElement) {
    const rect = target.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  if (e && typeof e.clientX === 'number') {
    return { x: e.clientX, y: e.clientY }
  }
  return {
    x: typeof window !== 'undefined' ? window.innerWidth / 2 : 0,
    y: typeof window !== 'undefined' ? window.innerHeight * 0.35 : 0,
  }
}
