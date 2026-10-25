// Apply the saved theme before first paint to avoid a flash.
// Mirrors getInitialTheme() in src/context/ThemeContext.jsx.
// Extracted from an inline <script> so the CSP can use script-src 'self'.

// The sign-in page's first paint in index.html (issue #389) shows only on
// /login: every route is served the same index.html, and CSS cannot read the
// address, so this marks it before the body is drawn.
if (/^\/login\/?$/.test(location.pathname)) document.documentElement.setAttribute('data-shell', 'login')

try {
  var t = localStorage.getItem('pih-theme')
  if (t !== 'light' && t !== 'dark') {
    t = localStorage.getItem('pih-dark') === '1' ? 'dark'
      : window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light'
      : 'dark'
  }
  if (t === 'dark') document.documentElement.classList.add('dark')
  // Keep the browser chrome / installed-app status bar in step with the theme:
  // the colour of the top band (paper in light, ink in dark), so the status
  // bar and the header read as one strip.
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', t === 'dark' ? '#050608' : '#FFFFFF')
} catch {
  document.documentElement.classList.add('dark')
}
