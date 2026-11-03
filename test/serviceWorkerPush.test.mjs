import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The website's service worker shows each Web Push (boilerindy-react/public/sw.js).
// It runs here in a bare context with a fake `self`, so a test can hand its
// push listener a payload and read what it asks the browser to show: the
// subtitle leading the body (issue #550, item 2), and the campus all clear
// replacing its alert under the same tag, again aloud by day and silently in
// quiet hours (item 9). Demo text only.

const source = readFileSync(new URL('../boilerindy-react/public/sw.js', import.meta.url), 'utf8')

function loadWorker() {
  const listeners = new Map()
  const shown = []
  const self = {
    location: { origin: 'https://www.boilerindy.app' },
    addEventListener: (type, listener) => listeners.set(type, listener),
    registration: {
      showNotification: async (title, options) => {
        // As the browser does: renotify needs a tag.
        if (options.renotify && !options.tag) throw new TypeError('renotify needs a tag')
        shown.push({ title, ...options })
      },
    },
  }
  vm.runInNewContext(source, { self, URL, console })
  const push = async (payload) => {
    const pending = []
    listeners.get('push')({ data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (promise) => pending.push(promise) })
    await Promise.all(pending)
    return shown.at(-1)
  }
  return { push }
}

test('a push shows its title, the subtitle leading the body, and its tag, and plays as usual', async () => {
  const { push } = loadWorker()
  const shown = await push({ kind: 'dining-favorites', title: 'Demo dish is on today', subtitle: 'Tower Dining · lunch', body: 'Sample body.', url: '/dining?hall=tower-dining&meal=lunch', tag: 'dining-favorites-2026-11-02' })
  assert.equal(shown.title, 'Demo dish is on today')
  assert.equal(shown.body, 'Tower Dining · lunch\nSample body.')
  assert.equal(shown.tag, 'dining-favorites-2026-11-02')
  // The worker's objects come from its own context, so compare their fields.
  assert.equal(shown.data.url, '/dining?hall=tower-dining&meal=lunch')
  assert.deepEqual([shown.silent, shown.renotify], [false, false])
})

test('the campus all clear replaces its alert aloud by day and silently in quiet hours', async () => {
  const { push } = loadWorker()
  const clear = { kind: 'campus-all-clear', title: 'IU Indianapolis alert', subtitle: 'Sent 1:30 PM', body: 'Demo alert: Campus Status Normal', url: '/safety?incident=demo', tag: 'campus-demo' }
  const day = await push({ ...clear, renotify: true })
  assert.deepEqual([day.tag, day.silent, day.renotify], ['campus-demo', false, true])
  const night = await push({ ...clear, silent: true })
  assert.deepEqual([night.tag, night.silent, night.renotify], ['campus-demo', true, false])
  // A payload asking to renotify without a tag still shows, without it.
  const untagged = await push({ ...clear, tag: undefined, renotify: true })
  assert.deepEqual([untagged.tag, untagged.renotify], [undefined, false])
})
