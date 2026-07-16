/// <reference types="vite/client" />

// Web Speech API (issue #19). Still non-standard, so it is absent from
// lib.dom.d.ts - declare the minimal surface consumed by useSpeechRecognition.
interface SpeechRecognitionResultLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}

interface SpeechRecognitionLike {
  interimResults: boolean
  continuous: boolean
  lang: string
  onresult: ((event: SpeechRecognitionResultLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

interface Window {
  SpeechRecognition?: SpeechRecognitionCtor
  webkitSpeechRecognition?: SpeechRecognitionCtor
  // Leaflet is loaded from a CDN <script> on the Transit page (issue #8), so it
  // lives on window rather than being imported.
  L?: typeof import('leaflet')
  // Safari-prefixed Web Audio constructor, absent from lib.dom.
  webkitAudioContext?: typeof AudioContext
}
