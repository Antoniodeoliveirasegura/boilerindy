/// <reference types="vite/client" />

// Web Speech API (issue #19). Not part of lib.dom, and only implemented in
// Chromium browsers, so we declare the minimal surface the app actually uses.
interface SpeechRecognitionResultItem {
  readonly transcript: string
}

interface SpeechRecognitionResultGroup {
  readonly [index: number]: SpeechRecognitionResultItem
}

interface SpeechRecognitionResultListLike {
  readonly length: number
  readonly [index: number]: SpeechRecognitionResultGroup
}

interface SpeechRecognitionEventLike {
  readonly results: SpeechRecognitionResultListLike
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string
}

interface SpeechRecognitionLike {
  interimResults: boolean
  continuous: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

interface Window {
  SpeechRecognition?: SpeechRecognitionCtor
  webkitSpeechRecognition?: SpeechRecognitionCtor
}
