import '@testing-library/jest-dom'

// vitest's jsdom environment does not surface `localStorage` / `sessionStorage`
// on the global it builds (jsdom exposes them on the Window prototype, which
// the global population step does not copy), so every test that touches storage
// throws on `undefined`. Node's own experimental globals of the same name are
// no help either - they are unusable unless the process was started with
// --localstorage-file. Install a spec-shaped in-memory Storage instead.
class MemoryStorage {
  #entries = new Map()

  get length() {
    return this.#entries.size
  }

  key(index) {
    return [...this.#entries.keys()][index] ?? null
  }

  getItem(key) {
    const k = String(key)
    return this.#entries.has(k) ? this.#entries.get(k) : null
  }

  setItem(key, value) {
    this.#entries.set(String(key), String(value))
  }

  removeItem(key) {
    this.#entries.delete(String(key))
  }

  clear() {
    this.#entries.clear()
  }
}

for (const name of ['localStorage', 'sessionStorage']) {
  if (typeof globalThis[name]?.getItem === 'function') continue
  const storage = new MemoryStorage()
  const descriptor = { value: storage, configurable: true, writable: true }
  Object.defineProperty(globalThis, name, descriptor)
  if (typeof window !== 'undefined' && window !== globalThis) {
    Object.defineProperty(window, name, descriptor)
  }
}

// jsdom does not implement matchMedia; stub it so theme + reduced-motion
// checks (ThemeContext) work under test.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false
    },
  })
}
