import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Suspense } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { lazyRoute, reloadOnceForFailedChunk } from './lazyRoute'

// A route chunk that will not load (usually one a new deploy removed) reloads
// the page once to pick up the new build, and never loops.
let reload: ReturnType<typeof vi.fn>

beforeEach(() => {
  sessionStorage.clear()
  reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('reloadOnceForFailedChunk', () => {
  test('reloads on the first failure', () => {
    expect(reloadOnceForFailedChunk(1_000_000)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('does not reload again within 30 seconds, so an offline tab cannot loop', () => {
    reloadOnceForFailedChunk(1_000_000)
    expect(reloadOnceForFailedChunk(1_000_000 + 29_000)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('reloads again for a later failure', () => {
    reloadOnceForFailedChunk(1_000_000)
    expect(reloadOnceForFailedChunk(1_000_000 + 31_000)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  test('does not reload when session storage is unavailable, since nothing could stop a loop', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(reloadOnceForFailedChunk(1_000_000)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})

// Router transitions are off, so a page that suspends shows the loader for at
// least 300 ms. A page whose module is already loaded must render directly.
describe('lazyRoute', () => {
  afterEach(cleanup)

  function Page() {
    return <p>Events page</p>
  }
  const inSuspense = (node: React.ReactNode) => <Suspense fallback={<p>Loading</p>}>{node}</Suspense>

  test('a preloaded page renders at once, without the loader', async () => {
    const Events = lazyRoute(() => Promise.resolve({ default: Page }))
    await act(async () => {
      Events.preload()
    })
    render(inSuspense(<Events />))
    expect(screen.getByText('Events page')).toBeInTheDocument()
    expect(screen.queryByText('Loading')).toBeNull()
  })

  test('a page not loaded yet shows the loader, then the page', async () => {
    const Events = lazyRoute(() => Promise.resolve({ default: Page }))
    render(inSuspense(<Events />))
    expect(screen.getByText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('Events page')).toBeInTheDocument()
  })

  test('a failed preload is retried by the visit', async () => {
    const load = vi
      .fn<() => Promise<{ default: typeof Page }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ default: Page })
    const Events = lazyRoute(load)
    await act(async () => {
      Events.preload()
    })
    render(inSuspense(<Events />))
    expect(await screen.findByText('Events page')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
