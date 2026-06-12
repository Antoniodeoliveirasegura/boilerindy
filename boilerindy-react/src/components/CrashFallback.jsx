// Last-resort UI for the Sentry ErrorBoundary in main.jsx (issue #50). Inline
// styles on purpose: if the app crashed this early, the CSS pipeline may not
// have loaded either.

export default function CrashFallback() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <div>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong</h1>
        <p style={{ fontSize: 14, opacity: 0.75, marginBottom: 16 }}>
          The error has been reported. Reloading usually fixes it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: '10px 18px', borderRadius: 10, border: 0, background: '#CFB991', color: '#3E2200', fontWeight: 600, cursor: 'pointer' }}
        >
          Reload BoilerIndy
        </button>
      </div>
    </div>
  )
}
