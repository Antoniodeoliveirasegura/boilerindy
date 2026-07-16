import { Component, type ErrorInfo, type ReactNode } from 'react'
import CrashFallback from './CrashFallback'

type Props = { children: ReactNode }
type State = { hasError: boolean }

// Plain React error boundary so @sentry/react stays out of the initial bundle.
// Caught errors are still forwarded to Sentry, but lazily - captureException is
// a no-op until Sentry has initialized (see main.jsx), and the dynamic import
// never blocks the fallback UI from rendering.
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    import('@sentry/react')
      .then((Sentry) =>
        Sentry.captureException?.(error, {
          contexts: { react: info as unknown as Record<string, unknown> },
        }),
      )
      .catch(() => {})
  }

  render() {
    return this.state.hasError ? <CrashFallback /> : this.props.children
  }
}
