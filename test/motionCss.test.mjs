// The motion tokens and rules in boilerindy-react/src/index.css
// (docs/motion.md). The values are the iOS app's Option D motion spec, so the
// site and the app move alike, and the rules keep motion to transform and
// opacity and honour Reduce Motion. (The frontend's Vitest setup blanks every
// .css import, so the check lives here.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'boilerindy-react')
const css = readFileSync(path.join(FRONTEND, 'src', 'index.css'), 'utf8')
const theme = css.match(/@theme static \{([^}]*)\}/)?.[1] ?? ''

function token(name) {
  return theme.match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`))?.[1].trim()
}

test("the motion durations are the app spec's", () => {
  assert.deepEqual(
    Object.fromEntries(
      ['fast', 'scrim', 'base', 'slow', 'sheet', 'roll', 'stagger', 'rise'].map((name) => [name, token(`--motion-${name}`)]),
    ),
    {
      fast: '150ms',
      scrim: '200ms',
      base: '260ms',
      slow: '420ms',
      sheet: '460ms',
      roll: '560ms',
      stagger: '40ms',
      rise: '10px',
    },
  )
})

test("the motion curves are the app spec's", () => {
  assert.deepEqual(
    Object.fromEntries(['out-expo', 'sheet', 'spring', 'roll', 'exit'].map((name) => [name, token(`--ease-${name}`)])),
    {
      'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      sheet: 'cubic-bezier(0.32, 1.18, 0.5, 1)',
      spring: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
      roll: 'cubic-bezier(0.34, 1.25, 0.64, 1)',
      exit: 'cubic-bezier(0.4, 0, 1, 1)',
    },
  )
})

test('the motion keyframes move only transform and opacity', () => {
  const blocks = [...css.matchAll(/@keyframes (motion-[\w-]+) \{([\s\S]*?)\n\}/g)]
  assert.deepEqual(blocks.map(([, name]) => name).sort(), [
    'motion-fade-in',
    'motion-fade-out',
    'motion-pop-in',
    'motion-pop-out',
    'motion-rise',
    'motion-roll',
    'motion-sheet-in',
    'motion-sheet-out',
    'motion-toast-in',
    'motion-toast-out',
  ])
  for (const [, name, body] of blocks) {
    for (const [, property] of body.matchAll(/([a-z-]+):/g)) {
      assert.ok(['opacity', 'transform'].includes(property), `${name} animates ${property}`)
    }
  }
})

test('overlays close faster than they open, and a closing one takes no taps', () => {
  assert.match(css, /\[data-motion="open"\] > \.motion-sheet \{ animation: motion-sheet-in var\(--motion-sheet\)/)
  assert.match(css, /\[data-motion="closed"\] > \.motion-sheet \{ animation: motion-sheet-out var\(--motion-base\)/)
  assert.match(css, /\.motion-pop\[data-motion="open"\] \{ animation: motion-pop-in var\(--motion-base\)/)
  assert.match(css, /\.motion-pop\[data-motion="closed"\] \{ animation: motion-pop-out var\(--motion-fast\)/)
  assert.match(css, /\.motion-toast\[data-motion="closed"\] \{ animation: motion-toast-out var\(--motion-base\)/)
  assert.ok(css.includes('[data-motion="closed"] { pointer-events: none; }'))
})

test('rows and page blocks rise only for people who have not asked for less motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\[data-entering\] > \*,/)
})

test('with Reduce Motion nothing moves, and dialogs, menus and toasts keep a short fade', () => {
  const reduce = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(reduce, /animation-duration: 0\.01ms !important/)
  assert.match(reduce, /\[data-motion="open"\][^{]*\{\s*animation: motion-fade-in var\(--motion-fast\) ease backwards !important;/)
  assert.match(reduce, /\[data-motion="closed"\][^{]*\{\s*animation: motion-fade-out var\(--motion-fast\) ease forwards !important;/)
})
