import { afterEach, describe, expect, test } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { usePresence } from './usePresence'
import { fakeAnimation, installFakeAnimations, type FakeAnimation } from '../lib/fakeAnimations'

// usePresence keeps an overlay on the page while it plays its exit
// (docs/motion.md). Without the Web Animations API, as in jsdom, it leaves in
// the commit that closes it, which is what every other component test sees.

let uninstall: (() => void) | null = null
afterEach(() => {
  cleanup()
  uninstall?.()
  uninstall = null
})

function Overlay({ open }: { open: boolean }) {
  const { attach, mounted, motion, opening } = usePresence(open)
  if (!mounted) return null
  return (
    <div ref={attach} data-testid="overlay" data-motion={motion} data-opening={opening} />
  )
}

/** The exit runs while the overlay is closed, and the test ends it. */
function withExit(): { exit: FakeAnimation } {
  const state = { exit: fakeAnimation({ endTime: 260 }) }
  uninstall = installFakeAnimations((el) => (el.getAttribute('data-motion') === 'closed' ? [state.exit] : []))
  return state
}

describe('usePresence', () => {
  test('renders nothing while closed', () => {
    render(<Overlay open={false} />)
    expect(screen.queryByTestId('overlay')).toBeNull()
  })

  test('opens marked open, counting the opening', () => {
    render(<Overlay open />)
    const overlay = screen.getByTestId('overlay')
    expect(overlay).toHaveAttribute('data-motion', 'open')
    expect(overlay).toHaveAttribute('data-opening', '1')
  })

  test('without the Web Animations API, leaves in the commit that closes it', () => {
    const view = render(<Overlay open />)
    view.rerender(<Overlay open={false} />)
    expect(screen.queryByTestId('overlay')).toBeNull()
  })

  test('stays on the page, marked closed, until its exit has finished', async () => {
    const { exit } = withExit()
    const view = render(<Overlay open />)
    view.rerender(<Overlay open={false} />)

    const overlay = screen.getByTestId('overlay')
    expect(overlay).toHaveAttribute('data-motion', 'closed')
    await act(async () => {})
    expect(screen.getByTestId('overlay')).toBe(overlay)

    await act(async () => exit.finish())
    expect(screen.queryByTestId('overlay')).toBeNull()
  })

  test('leaves at once when nothing is animating, such as Reduce Motion with no exit', async () => {
    uninstall = installFakeAnimations(() => [])
    const view = render(<Overlay open />)
    view.rerender(<Overlay open={false} />)
    await act(async () => {})
    expect(screen.queryByTestId('overlay')).toBeNull()
  })

  test('does not wait for an animation that never ends', async () => {
    uninstall = installFakeAnimations(() => [fakeAnimation({ endTime: Infinity })])
    const view = render(<Overlay open />)
    view.rerender(<Overlay open={false} />)
    await act(async () => {})
    expect(screen.queryByTestId('overlay')).toBeNull()
  })

  test('opening again during the exit keeps it, open, as a new opening', async () => {
    const { exit } = withExit()
    const view = render(<Overlay open />)
    view.rerender(<Overlay open={false} />)
    const overlay = screen.getByTestId('overlay')

    view.rerender(<Overlay open />)
    expect(screen.getByTestId('overlay')).toBe(overlay)
    expect(overlay).toHaveAttribute('data-motion', 'open')
    expect(overlay).toHaveAttribute('data-opening', '2')

    // The old exit finishing must not take the reopened overlay away.
    await act(async () => exit.finish())
    expect(screen.getByTestId('overlay')).toBe(overlay)
  })
})
