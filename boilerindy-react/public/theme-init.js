// Apply the saved theme before first paint to avoid a flash.
// Mirrors getInitialTheme() in src/context/ThemeContext.jsx.
// Extracted from an inline <script> so the CSP can use script-src 'self'.
try {
  var t = localStorage.getItem('pih-theme')
  if (t !== 'light' && t !== 'dark') {
    t = localStorage.getItem('pih-dark') === '1' ? 'dark'
      : window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light'
      : 'dark'
  }
  if (t === 'dark') document.documentElement.classList.add('dark')
} catch (e) {
  document.documentElement.classList.add('dark')
}
