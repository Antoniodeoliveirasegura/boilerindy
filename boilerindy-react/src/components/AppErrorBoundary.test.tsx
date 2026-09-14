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
})
