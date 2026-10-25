import { afterEach, describe, expect, test } from 'vitest'
import indexHtml from '../../index.html?raw'
import themeInit from '../../public/theme-init.js?raw'

// The sign-in page's first paint (issue #389): index.html draws the form's
// shape, block for block as SignInSkeleton does, inside the root the app
// replaces, before the app has loaded. Every route is served the same
// index.html, so theme-init.js marks /login before the body is drawn and only
// then does the shape show. Its colours are checked against the theme tokens
// in test/signInFirstPaint.test.mjs, since this setup blanks .css imports.

const page = new DOMParser().parseFromString(indexHtml, 'text/html')
const shell = page.querySelector('#root > .login-shell')
const style = page.querySelector('head style')?.textContent ?? ''

describe('index.html: the sign-in first paint', () => {
  test('sits in the root the app replaces, hidden unless theme-init marked /login', () => {
    expect(shell).not.toBeNull()
    expect(style).toMatch(/\n\s*\.login-shell \{[^}]*display: none;/)
    expect(style).toContain("[data-shell='login'] .login-shell { display: grid; }")
  })

  // Shapes only: nothing for a screen reader to read and nothing to tab to
  // before the real page arrives.
  test('is hidden from assistive technology and holds nothing focusable', () => {
    expect(shell?.getAttribute('aria-hidden')).toBe('true')
    expect(shell?.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0)
  })

  test('holds still for people who asked for less motion', () => {
    expect(style).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{[^}]*\.ls-spin \{ animation:/)
    expect(style.match(/animation:/g)).toHaveLength(2)
  })
})

describe('theme-init.js: marking the sign-in page', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    document.documentElement.removeAttribute('data-shell')
    document.documentElement.className = ''
    localStorage.clear()
  })

  function markFor(path: string): string | null {
    window.history.replaceState(null, '', path)
    document.documentElement.removeAttribute('data-shell')
    new Function(themeInit)()
    return document.documentElement.getAttribute('data-shell')
  }

  test.each(['/login', '/login/', '/login?next=%2Fdashboard', '/login?tab=signup'])('marks %s', (path) => {
    expect(markFor(path)).toBe('login')
  })

  test.each(['/', '/dashboard', '/dining', '/advertise', '/login-help', '/auth/callback'])('leaves %s unmarked', (path) => {
    expect(markFor(path)).toBeNull()
  })

  test('still applies the saved theme', () => {
    localStorage.setItem('pih-theme', 'dark')
    markFor('/login')
    expect(document.documentElement).toHaveClass('dark')
  })
})
