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
  // The catch must always resolve to a real Response - returning undefined to
  // respondWith() throws "Failed to convert value to 'Response'" (and shows the
  // request as a network error), which happens on first load before the shell is
  // cached. Response.error() is a valid last resort when we truly have nothing.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = (await caches.match(SHELL_URL)) || (await caches.match('/'))
        return cached || Response.error()
      }),
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

// ---------------------------------------------------------------------------
// Web Push (issue #9). The server sends a small JSON payload per notification:
//   { title, body, url, tag, kind } - url is a same-origin path such as
//   '/assignments'. Everything below is best-effort: a malformed payload still
//   shows a notification (userVisibleOnly requires one), and a failed
//   re-subscribe is left for the user to redo from Settings.
// ---------------------------------------------------------------------------

const NOTIFICATION_ICON = '/icons/icon-192.png'

function parsePushPayload(data) {
  const fallback = { title: 'BoilerIndy', body: '', url: '/', tag: undefined }
  if (!data) return fallback
  try {
    const parsed = data.json()
    if (parsed && typeof parsed === 'object') {
      return {
        title: typeof parsed.title === 'string' && parsed.title ? parsed.title : fallback.title,
        body: typeof parsed.body === 'string' ? parsed.body : '',
        url: typeof parsed.url === 'string' && parsed.url ? parsed.url : '/',
        tag: typeof parsed.tag === 'string' && parsed.tag ? parsed.tag : undefined,
      }
    }
  } catch {
    /* not JSON: show the raw text instead */
  }
  try {
    return { ...fallback, body: data.text() }
  } catch {
    return fallback
  }
}

self.addEventListener('push', (event) => {
  const { title, body, url, tag } = parsePushPayload(event.data)
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      tag,
      data: { url },
    }),
  )
})

// Only ever open our own origin: a payload url that is cross-origin (or not a
// url at all) falls back to the app root.
function resolveNotificationUrl(raw) {
  const root = new URL('/', self.location.origin).href
  try {
    const url = new URL(typeof raw === 'string' && raw ? raw : '/', self.location.origin)
    return url.origin === self.location.origin ? url.href : root
  } catch {
    return root
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const url = resolveNotificationUrl(data.url)

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        const existing = windowClients.find((client) => {
          try {
            return new URL(client.url).origin === self.location.origin
          } catch {
            return false
          }
        })
        if (!existing) return self.clients.openWindow(url)

        return Promise.resolve(existing.focus())
          .then((focused) => {
            const client = focused || existing
            if (client.url === url) return client
            if (typeof client.navigate === 'function') return client.navigate(url)
            return self.clients.openWindow(url)
          })
          .catch(() => self.clients.openWindow(url))
      })
      .catch(() => undefined),
  )
})

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function applicationServerKeyFor(event) {
  const existing = event.oldSubscription?.options?.applicationServerKey
  if (existing) return existing
  const response = await fetch('/api/push/config', { credentials: 'omit' })
  if (!response.ok) throw new Error(`push config responded ${response.status}`)
  const config = await response.json()
  if (!config || !config.enabled || typeof config.publicKey !== 'string' || !config.publicKey) {
    throw new Error('push is not enabled on the server')
  }
  return base64UrlToUint8Array(config.publicKey)
}

// The browser rotated or dropped the subscription (Firefox fires this; Chrome
// rarely does). Re-subscribe with the same VAPID key and tell the server, so
// reminders keep arriving without a visit to Settings.
async function renewSubscription(event) {
  try {
    let subscription = event.newSubscription || null
    if (!subscription) {
      const applicationServerKey = await applicationServerKeyFor(event)
      subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
    }
    await fetch('/api/push/subscriptions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON(), userAgent: self.navigator.userAgent }),
    })
  } catch {
    /* best-effort: the Settings card re-registers on its next visit */
  }
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(renewSubscription(event))
})
