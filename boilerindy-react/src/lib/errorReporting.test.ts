import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  MAX_PENDING,
  __resetErrorReportingForTests,
  attachBreadcrumbSink,
  attachErrorSink,
  captureEarlyWindowErrors,
  pendingCount,
  reportBreadcrumb,
  reportError,
} from './errorReporting'

// Issue #50 - errors raised before @sentry/react has initialised must reach
// Sentry once it has, in order, instead of hitting a no-op captureException.

beforeEach(() => __resetErrorReportingForTests())
afterEach(() => {
  __resetErrorReportingForTests()
  vi.restoreAllMocks()
})

describe('reportError / attachErrorSink', () => {
  test('buffers reports until a sink is attached, then drains them in order', () => {
    const first = new Error('first render crashed')
    const second = new Error('then a chunk failed')
    reportError(first, { contexts: { react: { componentStack: 'at App' } } })
    reportError(second)
    expect(pendingCount()).toBe(2)

    const sink = vi.fn()
    attachErrorSink(sink)

    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenNthCalledWith(1, first, { contexts: { react: { componentStack: 'at App' } } })
    expect(sink).toHaveBeenNthCalledWith(2, second, undefined)
    expect(pendingCount()).toBe(0)
  })

  test('forwards straight to the sink once attached', () => {
    const sink = vi.fn()
    attachErrorSink(sink)
    const err = new Error('later')
    reportError(err)
    expect(sink).toHaveBeenCalledWith(err, undefined)
    expect(pendingCount()).toBe(0)
  })

  test('caps the buffer and reports how many early errors were dropped', () => {
    for (let i = 0; i < MAX_PENDING + 3; i += 1) reportError(new Error(`e${i}`))
    expect(pendingCount()).toBe(MAX_PENDING)

    const sink = vi.fn()
    attachErrorSink(sink)
    expect(sink).toHaveBeenCalledTimes(MAX_PENDING + 1)
    const [summary, context] = sink.mock.calls[MAX_PENDING]
    expect((summary as Error).message).toMatch(/3 early error\(s\) dropped/)
    expect(context).toEqual({ contexts: { early: { dropped: 3 } } })
  })

  test('a throwing sink never propagates to the caller', () => {
    attachErrorSink(() => {
      throw new Error('sentry exploded')
    })
    expect(() => reportError(new Error('x'))).not.toThrow()
  })
})

// Issue #245 - a breadcrumb left before Sentry.init (the not-found page on a
// direct landing) used to hit an addBreadcrumb that drops it without a client.
describe('reportBreadcrumb / attachBreadcrumbSink', () => {
  test('holds breadcrumbs until a sink is attached, then replays them in order with the time they happened', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    reportBreadcrumb({ category: 'navigation', message: 'not-found', data: { path: '/old/link' } })
    now.mockReturnValue(1_500_000)
    reportBreadcrumb({ category: 'navigation', message: 'not-found', data: { path: '/other' } })
    now.mockReturnValue(9_000_000)

    const sink = vi.fn()
    attachBreadcrumbSink(sink)

    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenNthCalledWith(1, {
      timestamp: 1000,
      category: 'navigation',
      message: 'not-found',
      data: { path: '/old/link' },
    })
    expect(sink).toHaveBeenNthCalledWith(2, {
      timestamp: 1500,
      category: 'navigation',
      message: 'not-found',
      data: { path: '/other' },
    })
  })

  test('forwards straight to the sink once attached, and only once', () => {
    const sink = vi.fn()
    attachBreadcrumbSink(sink)
    reportBreadcrumb({ message: 'later' })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0]).toMatchObject({ message: 'later' })
    expect(typeof sink.mock.calls[0][0].timestamp).toBe('number')

    attachBreadcrumbSink(sink)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  test('keeps only the newest breadcrumbs before a sink attaches and never turns the drop into an error', () => {
    for (let i = 0; i < MAX_PENDING + 3; i += 1) reportBreadcrumb({ message: `c${i}` })
    expect(pendingCount()).toBe(0)

    const errorSink = vi.fn()
    attachErrorSink(errorSink)
    const sink = vi.fn()
    attachBreadcrumbSink(sink)

    expect(sink).toHaveBeenCalledTimes(MAX_PENDING)
    expect(sink.mock.calls[0][0]).toMatchObject({ message: 'c3' })
    expect(sink.mock.calls[MAX_PENDING - 1][0]).toMatchObject({ message: `c${MAX_PENDING + 2}` })
    expect(errorSink).not.toHaveBeenCalled()
  })

  test('a throwing breadcrumb sink never propagates to the caller', () => {
    reportBreadcrumb({ message: 'early' })
    expect(() =>
      attachBreadcrumbSink(() => {
        throw new Error('sentry exploded')
      }),
    ).not.toThrow()
    expect(() => reportBreadcrumb({ message: 'x' })).not.toThrow()
  })
})

describe('captureEarlyWindowErrors', () => {
  test('buffers window error and unhandledrejection events until detached', () => {
    // A private target: dispatching on the real jsdom window makes vitest
    // report the event as an unhandled error, which is the very thing under test.
    const target = new EventTarget() as unknown as Window
    const detach = captureEarlyWindowErrors(target)

    const thrown = new Error('uncaught during boot')
    target.dispatchEvent(new ErrorEvent('error', { error: thrown, message: thrown.message }))

    const rejection = new Event('unhandledrejection')
    Object.defineProperty(rejection, 'reason', { value: new Error('rejected during boot') })
    target.dispatchEvent(rejection)

    expect(pendingCount()).toBe(2)

    const sink = vi.fn()
    attachErrorSink(sink)
    expect(sink).toHaveBeenNthCalledWith(1, thrown, { contexts: { early: { mechanism: 'onerror' } } })
    expect((sink.mock.calls[1][0] as Error).message).toBe('rejected during boot')
    expect(sink.mock.calls[1][1]).toEqual({ contexts: { early: { mechanism: 'onunhandledrejection' } } })

    // After detaching, the window listeners are gone: Sentry's own handlers own
    // these events from here on, so nothing is reported twice.
    detach()
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('after detach'), message: 'after detach' }))
    expect(sink).toHaveBeenCalledTimes(2)
  })
})
