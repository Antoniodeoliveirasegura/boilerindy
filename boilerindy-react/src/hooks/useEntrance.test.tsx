import { afterEach, describe, expect, test } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useEntrance } from './useEntrance'
import { fakeAnimation, installFakeAnimations, type FakeAnimation } from '../lib/fakeAnimations'

// useEntrance lets a list's rows rise in when its content lands after the
// first render and when its filter changes, and never otherwise; a row that
// arrives later rises by itself (docs/motion.md). jsdom has no Web Animations
// API, so the tests that need one install a fake whose rise they end.

let uninstall: (() => void) | null = null
afterEach(() => {
  cleanup()
  uninstall?.()
  uninstall = null
})

function List({ ready, filter, rows }: { ready: boolean; filter?: string; rows: string[] }) {
  const ref = useEntrance<HTMLUListElement>(ready, filter)
  if (!ready) return <p>Loading</p>
  return (
    <ul ref={ref} data-testid="list">
      {rows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ul>
  )
}

/** A rise runs while the list carries data-entering, until the test ends it. */
function withRise(): { rise: FakeAnimation } {
  const state = { rise: fakeAnimation({ name: 'motion-rise', endTime: 700 }) }
  uninstall = installFakeAnimations((el) => (el.hasAttribute('data-entering') ? [state.rise] : []))
  return state
}

async function endRise(rise: FakeAnimation) {
  await act(async () => rise.finish())
  await act(async () => {})
}

describe('useEntrance', () => {
  test('does nothing without the Web Animations API', () => {
    const view = render(<List ready={false} rows={[]} />)
    view.rerender(<List ready rows={['a', 'b']} />)
    expect(screen.getByTestId('list')).not.toHaveAttribute('data-entering')
  })

  test('stays still on the first render, where the rows were already there', () => {
    withRise()
    render(<List ready rows={['a', 'b']} />)
    expect(screen.getByTestId('list')).not.toHaveAttribute('data-entering')
  })

  test('lets the rows rise when they land after a loading state, then takes the attribute off', async () => {
    const { rise } = withRise()
    const view = render(<List ready={false} rows={[]} />)
    view.rerender(<List ready rows={['a', 'b', 'c']} />)
    const list = screen.getByTestId('list')
    expect(list).toHaveAttribute('data-entering')

    await endRise(rise)
    expect(list).not.toHaveAttribute('data-entering')
  })

  test('lets them rise again when the filter changes', async () => {
    const { rise } = withRise()
    const view = render(<List ready filter="all" rows={['a', 'b']} />)
    view.rerender(<List ready filter="food" rows={['c']} />)
    expect(screen.getByTestId('list')).toHaveAttribute('data-entering')
    await endRise(rise)
  })

  test('a refetch with the same filter replays nothing, and a new row rises by itself', async () => {
    withRise()
    const view = render(<List ready filter="all" rows={['a', 'b']} />)
    view.rerender(<List ready filter="all" rows={['new', 'a', 'b']} />)
    await act(async () => {})

    const list = screen.getByTestId('list')
    expect(list).not.toHaveAttribute('data-entering')
    expect(screen.getByText('new')).toHaveAttribute('data-arrive')
    expect(screen.getByText('a')).not.toHaveAttribute('data-arrive')
  })

  test('a reorder is not an arrival', async () => {
    withRise()
    const view = render(<List ready rows={['a', 'b', 'c']} />)
    view.rerender(<List ready rows={['c', 'a', 'b']} />)
    await act(async () => {})
    for (const row of ['a', 'b', 'c']) expect(screen.getByText(row)).not.toHaveAttribute('data-arrive')
  })

  test('an arrival rises once: the attribute comes off when its animation ends', async () => {
    withRise()
    const view = render(<List ready rows={['a']} />)
    view.rerender(<List ready rows={['a', 'b']} />)
    await act(async () => {})
    const row = screen.getByText('b')
    expect(row).toHaveAttribute('data-arrive')
    row.dispatchEvent(new Event('animationend'))
    expect(row).not.toHaveAttribute('data-arrive')
  })

  test('stays still inside a page that is rising in after a navigation', () => {
    withRise()
    const main = document.createElement('main')
    main.setAttribute('data-route-enter', '')
    document.body.append(main)
    const view = render(<List ready={false} rows={[]} />, { container: main })
    view.rerender(<List ready rows={['a']} />)
    expect(screen.getByTestId('list')).not.toHaveAttribute('data-entering')
    main.remove()
  })
})
