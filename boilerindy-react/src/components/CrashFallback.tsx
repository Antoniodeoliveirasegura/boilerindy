// Last-resort UI for the Sentry ErrorBoundary in main.jsx (issue #50). Inline
// styles on purpose: if the app crashed this early, the CSS pipeline may not
// have loaded either.

export default function CrashFallback() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 8 }}>Something went wrong</h1>
        <p style={{ fontSize: 14, opacity: 0.75, marginBottom: 16 }}>
          The error has been reported. Reloading usually fixes it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ minHeight: 44, padding: '0 18px', borderRadius: 5, border: '1.5px solid rgba(23, 18, 10, 0.22)', background: '#F4A51C', color: '#17120A', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
        >
          Reload BoilerIndy
        </button>
      </div>
    </div>
  )
}
