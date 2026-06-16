import { useCallback, useEffect, useRef, useState } from 'react'

// Push-to-talk speech-to-text for the campus assistant (issue #19). Thin wrapper
// over the browser Web Speech API (Chrome/Android). Where the API is missing
// (Safari/iOS), `supported` is false and callers simply hide the mic — typing
// still works, and no error is surfaced.

function getRecognitionCtor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

/**
 * @param {object} [options]
 * @param {(transcript: string) => void} [options.onResult] - fired with the live
 *   (interim + final) cumulative transcript of the current utterance.
 * @param {string} [options.lang]
 * @returns {{ supported: boolean, listening: boolean, error: string | null,
 *   start: () => void, stop: () => void, toggle: () => void }}
 */
export function useSpeechRecognition({ onResult, lang = 'en-US' } = {}) {
  const Ctor = getRecognitionCtor()
  const supported = Boolean(Ctor)

  const [listening, setListening] = useState(false)
  const [error, setError] = useState(null)

  const recognitionRef = useRef(null)
  // Hold the callback in a ref so the recognizer is built once, not rebuilt on
  // every render when the parent passes a fresh onResult function. Written in an
  // effect (not during render) to satisfy the rules of hooks.
  const onResultRef = useRef(onResult)
  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  useEffect(() => {
    if (!supported) return undefined

    const recognition = new Ctor()
    recognition.interimResults = true
    recognition.continuous = false
    recognition.lang = lang

    recognition.onresult = (event) => {
      let transcript = ''
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript
      }
      onResultRef.current?.(transcript)
    }
    recognition.onerror = (event) => {
      setError(event?.error || 'speech-error')
      setListening(false)
    }
    recognition.onend = () => setListening(false)

    recognitionRef.current = recognition

    return () => {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try {
        recognition.abort()
      } catch {
        /* abort throws if it was never started — safe to ignore */
      }
      recognitionRef.current = null
    }
  }, [supported, Ctor, lang])

  const start = useCallback(() => {
    const recognition = recognitionRef.current
    if (!recognition || listening) return
    setError(null)
    try {
      recognition.start()
      setListening(true)
    } catch {
      /* start() throws if already started — ignore */
    }
  }, [listening])

  const stop = useCallback(() => {
    const recognition = recognitionRef.current
    if (!recognition) return
    try {
      recognition.stop()
    } catch {
      /* ignore */
    }
    setListening(false)
  }, [])

  const toggle = useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  return { supported, listening, error, start, stop, toggle }
}
