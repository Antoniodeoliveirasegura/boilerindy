import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FlapDigit from './FlapDigit'
import { installFakeAnimations } from '../lib/fakeAnimations'

// A departures board tile (docs/motion.md): its digit rolls over when it
// changes and rolls in from a blank tile when it first shows. jsdom has no Web
// Animations API, so the tests that need one install a fake.

let uninstall: (() => void) | null = null
afterEach(() => {
  cleanup()
  uninstall?.()
  uninstall = null
  vi.restoreAllMocks()
})

function rolls() {
  uninstall = installFakeAnimations(() => [])
}

function strip() {
  const roll = screen.queryByTestId('flap-roll')
  return roll ? Array.from(roll.querySelectorAll(':scope > span > span')).map((cell) => cell.textContent) : null
}

describe('FlapDigit', () => {
  test('shows its digit in a tile, hidden from screen readers like the rest of the board', () => {
    const { container } = render(<FlapDigit value="9" />)
    const tile = container.querySelector('.flap')
    expect(tile).toHaveTextContent('9')
    expect(tile).toHaveAttribute('aria-hidden', 'true')
    expect(strip()).toBeNull()
  })

  test('without the Web Animations API a change simply shows the new digit', () => {
    const view = render(<FlapDigit value="9" />)
    view.rerender(<FlapDigit value="1" />)
    expect(strip()).toBeNull()
    expect(view.container.querySelector('.flap')).toHaveTextContent('1')
  })

  test('rolls in from a blank tile when it first shows', () => {
    rolls()
    render(<FlapDigit value="3" index={2} />)
    expect(strip()).toEqual([' ', '3'])
    expect(screen.getByTestId('flap-roll').style.getPropertyValue('--flap-i')).toBe('2')
  })

  test('rolls from the old digit to the new one, and comes to rest when the roll ends', () => {
    rolls()
    const view = render(<FlapDigit value="9" />)
    fireEvent.animationEnd(screen.getByTestId('flap-roll'))
    expect(strip()).toBeNull()

    view.rerender(<FlapDigit value="1" />)
    expect(strip()).toEqual(['9', '1'])
    fireEvent.animationEnd(screen.getByTestId('flap-roll'))
    expect(strip()).toBeNull()
    expect(view.container.querySelector('.flap')).toHaveTextContent('1')
  })

  test('with Reduce Motion the new digit is simply there', () => {
    rolls()
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    )
    const view = render(<FlapDigit value="9" />)
    view.rerender(<FlapDigit value="1" />)
    expect(strip()).toBeNull()
  })
})
