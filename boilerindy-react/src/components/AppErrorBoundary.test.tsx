import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import AppErrorBoundary from './AppErrorBoundary'
import { __resetErrorReportingForTests, attachErrorSink, pendingCount } from '../lib/errorReporting'

// Issue #50 - a crash during the first render is the highest-value error and
// used to be dropped because captureException was a no-op until Sentry had
// initialised. The boundary now reports through the buffering seam.

function Boom(): never {
  throw new Error('first render crashed')
}

afterEach(() => {
  cleanup()
  __resetErrorReportingForTests()
  vi.restoreAllMocks()
})

describe('AppErrorBoundary', () => {
  test('shows the crash fallback and buffers the error until Sentry attaches', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}) // React logs the caught error
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    )

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument()
    expect(pendingCount()).toBe(1)

    const sink = vi.fn()
    attachErrorSink(sink)
    expect(sink).toHaveBeenCalledTimes(1)
    const [error, context] = sink.mock.calls[0]
    expect((error as Error).message).toBe('first render crashed')
    expect(context).toMatchObject({ contexts: { react: { componentStack: expect.any(String) } } })
  })

  test('tries its children again when resetKey changes, so the next page is not stuck on the crash screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(
      <AppErrorBoundary resetKey="/schedule">
        <Boom />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument()

    rerender(
      <AppErrorBoundary resetKey="/schedule">
        <p>still crashed</p>
      </AppErrorBoundary>,
    )
    expect(screen.queryByText('still crashed')).not.toBeInTheDocument()

    rerender(
      <AppErrorBoundary resetKey="/dashboard">
        <p>Dashboard</p>
      </AppErrorBoundary>,
    )
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
  })

  test('a page that crashes on the navigation that changed the key is rendered and reported once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink = vi.fn()
    attachErrorSink(sink)
    let renders = 0
    function CountedBoom(): never {
      renders += 1
      throw new Error('crashed on arrival')
    }
    const { rerender } = render(
      <AppErrorBoundary resetKey="/dashboard">
        <p>Dashboard</p>
      </AppErrorBoundary>,
    )
    rerender(
      <AppErrorBoundary resetKey="/events">
        <CountedBoom />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument()
    const rendersAfterCrash = renders
    expect(sink).toHaveBeenCalledTimes(1)

    rerender(
      <AppErrorBoundary resetKey="/events">
        <CountedBoom />
      </AppErrorBoundary>,
    )
    expect(renders).toBe(rendersAfterCrash)
    expect(sink).toHaveBeenCalledTimes(1)
  })
})
