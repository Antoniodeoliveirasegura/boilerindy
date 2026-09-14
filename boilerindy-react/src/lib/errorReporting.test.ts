import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  MAX_PENDING,
  __resetErrorReportingForTests,
  attachErrorSink,
  captureEarlyWindowErrors,
  pendingCount,
  reportError,
} from './errorReporting'

// Issue #50 - errors raised before @sentry/react has initialised must reach
// Sentry once it has, in order, instead of hitting a no-op captureException.

beforeEach(() => __resetErrorReportingForTests())
afterEach(() => __resetErrorReportingForTests())

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
