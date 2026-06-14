import { Component } from 'react'
import CrashFallback from './CrashFallback.jsx'

// Plain React error boundary so @sentry/react stays out of the initial bundle.
// Caught errors are still forwarded to Sentry, but lazily — captureException is
// a no-op until Sentry has initialized (see main.jsx), and the dynamic import
// never blocks the fallback UI from rendering.
export default class AppErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    import('@sentry/react')
      .then((Sentry) => Sentry.captureException?.(error, { contexts: { react: info } }))
      .catch(() => {})
  }

  render() {
    return this.state.hasError ? <CrashFallback /> : this.props.children
  }
}
