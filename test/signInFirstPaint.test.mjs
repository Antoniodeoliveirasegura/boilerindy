// The sign-in page's first paint (issue #389): boilerindy-react/index.html
// draws the form's shape before the app has loaded, in plain CSS, because the
// app's stylesheet may not be there yet. So it keeps its own copy of the theme
// colours, and this checks the copy against the index.css tokens in both
// themes. (The frontend's Vitest setup blanks every .css import, so the check
// lives here; SignInSkeleton.test.ts covers the rest of the shell.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'boilerindy-react')
const indexHtml = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8')
const indexCss = readFileSync(path.join(FRONTEND, 'src', 'index.css'), 'utf8')

// Each colour the shell paints with, and the index.css token it copies.
const COPIES = {
  '--ls-bg': '--color-bg-1',
  '--ls-bar': '--color-bg-2',
  '--ls-ink': '--color-ink-lift',
  '--ls-ink-txt': '--color-ink-txt',
  '--ls-txt-0': '--color-txt-0',
  '--ls-txt-2': '--color-txt-2',
  '--ls-line': '--color-border-2',
  '--ls-rule': '--color-border-3',
}

function declarations(block) {
  assert.ok(block, 'a rule block the test looks for is missing')
  const found = {}
  for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    found[name] = value.trim().toLowerCase().replace(/\s+/g, ' ')
  }
  return found
}

const tokens = {
  light: declarations(indexCss.match(/@theme static \{([^}]*)\}/)?.[1]),
  dark: declarations(indexCss.match(/\n\.dark \{([^}]*)\}/)?.[1]),
}
const shell = {
  light: declarations(indexHtml.match(/\n\s*\.login-shell \{([^}]*)\}/)?.[1]),
  dark: declarations(indexHtml.match(/\.dark \.login-shell \{([^}]*)\}/)?.[1]),
}

for (const theme of ['light', 'dark']) {
  test(`the sign-in first paint uses the ${theme} theme's colours`, () => {
    for (const [copy, token] of Object.entries(COPIES)) {
      // A colour the dark block does not set is the light one in both files.
      const painted = shell[theme][copy] ?? shell.light[copy]
      const themed = tokens[theme][token] ?? tokens.light[token]
      assert.ok(themed, `index.css has no ${token}`)
      assert.equal(painted, themed, `index.html ${copy} (${theme}) should match index.css ${token}`)
    }
  })
}
