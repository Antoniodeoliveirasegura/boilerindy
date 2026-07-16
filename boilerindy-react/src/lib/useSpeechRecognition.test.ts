import { afterEach, describe, expect, test, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSpeechRecognition } from './useSpeechRecognition'

// Issue #19 - push-to-talk dictation for the campus assistant. jsdom has no Web
// Speech API, so the unsupported path is the real environment; the supported
// path is exercised with a minimal fake recognizer.

afterEach(() => {
  delete window.SpeechRecognition
  delete window.webkitSpeechRecognition
  vi.restoreAllMocks()
})

// Minimal stand-in for the browser SpeechRecognition object.
class FakeRecognition implements SpeechRecognitionLike {
  interimResults = false
  continuous = true
  lang = ''
  onresult: SpeechRecognitionLike['onresult'] = null
  onerror: SpeechRecognitionLike['onerror'] = null
  onend: SpeechRecognitionLike['onend'] = null
  start = vi.fn()
  stop = vi.fn()
  abort = vi.fn()
  emitResult(transcripts: string[]) {
    this.onresult?.({ results: transcripts.map((t) => [{ transcript: t }]) })
  }
}

// Installs a fake recognizer as window.SpeechRecognition and returns a getter
// for the instance the hook constructs. A regular function (not an arrow) is
// required so the hook can `new` it; vi.fn isn't typed as constructable, hence
// the cast to the ambient SpeechRecognitionCtor.
function installFakeRecognition(): () => FakeRecognition {
  let instance: FakeRecognition | undefined
  window.SpeechRecognition = vi.fn(function () {
    instance = new FakeRecognition()
    return instance
  }) as unknown as SpeechRecognitionCtor
  return () => {
    if (!instance) throw new Error('SpeechRecognition was not constructed')
    return instance
  }
}

describe('useSpeechRecognition (unsupported environment)', () => {
  test('reports unsupported and start() is a no-op', () => {
    const { result } = renderHook(() => useSpeechRecognition({}))
    expect(result.current.supported).toBe(false)
    expect(result.current.listening).toBe(false)
    act(() => result.current.start())
    expect(result.current.listening).toBe(false)
  })
})

describe('useSpeechRecognition (supported environment)', () => {
  test('configures the recognizer per spec', () => {
    const getInstance = installFakeRecognition()
    renderHook(() => useSpeechRecognition({ onResult: () => {} }))
    const instance = getInstance()
    expect(instance.interimResults).toBe(true)
    expect(instance.continuous).toBe(false)
    expect(instance.lang).toBe('en-US')
  })

  test('start sets listening and stop clears it', () => {
    const getInstance = installFakeRecognition()
    const { result } = renderHook(() => useSpeechRecognition({ onResult: () => {} }))
    const instance = getInstance()
    expect(result.current.supported).toBe(true)

    act(() => result.current.start())
    expect(instance.start).toHaveBeenCalled()
    expect(result.current.listening).toBe(true)

    act(() => result.current.stop())
    expect(instance.stop).toHaveBeenCalled()
    expect(result.current.listening).toBe(false)
  })

  test('fires onResult with the cumulative transcript', () => {
    const onResult = vi.fn()
    const getInstance = installFakeRecognition()
    renderHook(() => useSpeechRecognition({ onResult }))
    act(() => getInstance().emitResult(['hello ', 'world']))
    expect(onResult).toHaveBeenCalledWith('hello world')
  })
})
