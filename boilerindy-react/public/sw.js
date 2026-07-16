// BoilerIndy service worker (issue #11). Runtime caching so the app shell and
// static assets work offline, without needing to know Vite's hashed filenames.
// Bump CACHE_VERSION to invalidate old caches on the next visit.

const CACHE_VERSION = 'v1'
const CACHE_NAME = `boilerindy-${CACHE_VERSION}`
const SHELL_URL = '/index.html'
const PRECACHE_URLS = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // leave cross-origin alone

  // Never cache dynamic/auth endpoints - always hit the network.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/feeds/') ||
    url.pathname.startsWith('/auth/')
  ) {
    return
  }

  // Navigations: network-first, fall back to the cached app shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(SHELL_URL).then((r) => r || caches.match('/'))),
    )
    return
  }

  // Static assets (JS/CSS/fonts/images): cache-first, revalidate in background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})
