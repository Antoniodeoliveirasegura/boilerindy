import { afterEach, describe, expect, test, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSpeechRecognition } from './useSpeechRecognition'

// Issue #19 — push-to-talk dictation for the campus assistant. jsdom has no Web
// Speech API, so the unsupported path is the real environment; the supported
// path is exercised with a minimal fake recognizer.

afterEach(() => {
  delete window.SpeechRecognition
  delete window.webkitSpeechRecognition
  vi.restoreAllMocks()
})

// Minimal stand-in for the browser SpeechRecognition object.
class FakeRecognition {
  constructor() {
    this.interimResults = false
    this.continuous = true
    this.lang = ''
    this.onresult = null
    this.onerror = null
    this.onend = null
    this.start = vi.fn()
    this.stop = vi.fn()
    this.abort = vi.fn()
  }
  emitResult(transcripts) {
    this.onresult({ results: transcripts.map((t) => [{ transcript: t }]) })
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
    let instance
    window.SpeechRecognition = vi.fn(function ctor() {
      instance = new FakeRecognition()
      return instance
    })
    renderHook(() => useSpeechRecognition({ onResult: () => {} }))
    expect(instance.interimResults).toBe(true)
    expect(instance.continuous).toBe(false)
    expect(instance.lang).toBe('en-US')
  })

  test('start sets listening and stop clears it', () => {
    let instance
    window.SpeechRecognition = vi.fn(function ctor() {
      instance = new FakeRecognition()
      return instance
    })
    const { result } = renderHook(() => useSpeechRecognition({ onResult: () => {} }))
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
    let instance
    window.SpeechRecognition = vi.fn(function ctor() {
      instance = new FakeRecognition()
      return instance
    })
    renderHook(() => useSpeechRecognition({ onResult }))
    act(() => instance.emitResult(['hello ', 'world']))
    expect(onResult).toHaveBeenCalledWith('hello world')
  })
})
